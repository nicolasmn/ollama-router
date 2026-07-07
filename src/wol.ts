// wol.ts - Wake-on-LAN utilities: ARP lookup, magic packet send
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as dgram from 'node:dgram'
import { URL } from 'node:url'

const execFileAsync = promisify(execFile)

export function extractIp(nodeHost: string): string {
  return new URL(nodeHost).hostname
}

export async function arpLookup(ip: string): Promise<string | null> {
  if (ip === 'localhost' || ip.startsWith('127.') || ip === '::1') return null
  try {
    const { stdout } = await execFileAsync('arp', ['-n', ip], { timeout: 3000 })
    return parseMac(stdout)
  } catch (err: unknown) {
    // arp exits non-zero when IP not cached, but may still print the MAC
    const stdout = (err as { stdout?: string }).stdout ?? ''
    return parseMac(stdout)
  }
}

function parseMac(output: string): string | null {
  const m = output.match(/ at ([0-9a-f:]+)/i)
  if (!m) return null
  const raw = m[1]
  if (raw === '(incomplete)') return null
  return raw.split(':').map(o => o.padStart(2, '0')).join(':').toLowerCase()
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

    const sock = dgram.createSocket('udp4')
    sock.bind(() => {
      sock.setBroadcast(true)
      // Send to both global broadcast and subnet broadcast for better WiFi compatibility
      sock.send(buf, 0, buf.length, 9, '255.255.255.255', (err) => {
        sock.close()
        if (err) reject(err)
        else resolve()
      })
    })
  })
}
