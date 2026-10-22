// wol.ts - Wake-on-LAN utilities: ARP lookup, magic packet send
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as dgram from 'node:dgram'
import { URL } from 'node:url'
import { networkInterfaces } from 'node:os'
import { createLogger } from './logger.js'

const execFileAsync = promisify(execFile)
const logger = createLogger('wol')

export function extractIp(nodeHost: string): string {
  return new URL(nodeHost).hostname
}

/**
 * Look up the MAC address for an IP via the kernel ARP/neighbour cache.
 * Tries `arp -n` first (net-tools); falls back to `ip neigh show` (iproute2)
 * which is always present on modern Linux systems (including Raspberry Pi OS).
 * Returns null for localhost addresses or when no cache entry exists.
 */
export async function arpLookup(ip: string): Promise<string | null> {
  if (ip === 'localhost' || ip.startsWith('127.') || ip === '::1') return null

  // --- attempt 1: arp (net-tools) ---
  try {
    const { stdout } = await execFileAsync('arp', ['-n', ip], { timeout: 3000 })
    const mac = parseMacArp(stdout)
    if (mac) return mac
  } catch (err: unknown) {
    // arp may exit non-zero but still print the MAC in stdout
    const stdout = (err as { stdout?: string }).stdout ?? ''
    const mac = parseMacArp(stdout)
    if (mac) return mac
    // ENOENT means arp binary not found — fall through to ip neigh
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.debug({ ip, err: (err as Error).message }, 'arp lookup failed, trying ip neigh')
    }
  }

  // --- attempt 2: ip neigh (iproute2 — always available on modern Linux) ---
  try {
    const { stdout } = await execFileAsync('ip', ['neigh', 'show', ip], { timeout: 3000 })
    return parseMacIpNeigh(stdout)
  } catch (err: unknown) {
    logger.debug({ ip, err: (err as Error).message }, 'ip neigh lookup failed')
    return null
  }
}

/** Parse MAC from `arp -n` output: "192.168.1.10 ether aa:bb:cc:dd:ee:ff C eth0" */
function parseMacArp(output: string): string | null {
  const m = output.match(/ at ([0-9a-f:]+)/i)
  if (!m) return null
  const raw = m[1]
  if (raw === '(incomplete)') return null
  return normaliseMac(raw)
}

/** Parse MAC from `ip neigh show` output: "192.168.1.10 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE" */
function parseMacIpNeigh(output: string): string | null {
  const m = output.match(/lladdr\s+([0-9a-f:]+)/i)
  if (!m) return null
  return normaliseMac(m[1])
}

function normaliseMac(raw: string): string | null {
  const parts = raw.split(':')
  if (parts.length !== 6) return null
  return parts.map(o => o.padStart(2, '0')).join(':').toLowerCase()
}

/** Collect all local IPv4 subnet broadcast addresses (e.g. 192.168.1.255). */
function getSubnetBroadcasts(): string[] {
  const broadcasts: string[] = []
  for (const ifaces of Object.values(networkInterfaces())) {
    if (!ifaces) continue
    for (const iface of ifaces) {
      if (iface.family !== 'IPv4' || iface.internal) continue
      const parts = iface.address.split('.').map(Number)
      const maskParts = iface.netmask.split('.').map(Number)
      const broadcast = parts.map((b, i) => (b | (~maskParts[i] & 0xff))).join('.')
      if (broadcast !== '255.255.255.255') broadcasts.push(broadcast)
    }
  }
  return broadcasts
}

export function sendWakeOnLan(mac: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const macBytes = mac.split(':').map(h => parseInt(h, 16))
    if (macBytes.length !== 6 || macBytes.some(b => isNaN(b))) {
      reject(new Error(`Invalid MAC address: ${mac}`))
      return
    }

    const buf = Buffer.alloc(102)
    buf.fill(0xff, 0, 6)
    for (let i = 0; i < 16; i++) macBytes.forEach((b, j) => buf.writeUInt8(b, 6 + i * 6 + j))

    const targets = ['255.255.255.255', ...getSubnetBroadcasts()]
    const sock = dgram.createSocket('udp4')
    sock.bind(() => {
      sock.setBroadcast(true)
      let pending = targets.length
      let firstErr: Error | null = null
      for (const target of targets) {
        sock.send(buf, 0, buf.length, 9, target, (err) => {
          if (err && !firstErr) firstErr = err
          if (--pending === 0) {
            sock.close()
            if (firstErr) reject(firstErr)
            else resolve()
          }
        })
      }
    })
  })
}
