// network-scanner.ts - Scan local subnets for Ollama nodes
import { request } from 'undici'
import { networkInterfaces } from 'node:os'
import { createConnection } from 'node:net'
import { createLogger } from './logger.js'

const logger = createLogger('scanner')

const OLLAMA_PORT = 11434
const SCAN_CONCURRENCY = 30
const SCAN_TIMEOUT_MS = 300

export interface ScanResult {
  url: string
  host: string
  responseTime: number
}

export class NetworkScanner {
  /**
   * Discover all /24 subnets from local network interfaces,
   * probe every host:11434, and return reachable Ollama URLs.
   */
  async scanLocalNetwork(): Promise<string[]> {
    const subnets = this._getLocalSubnets()
    if (subnets.length === 0) {
      logger.debug('No local subnets found for scanning')
      return []
    }

    const candidates = subnets.flatMap((subnet) =>
      this._buildCandidates(subnet),
    )
    logger.debug(
      { subnets: subnets.length, candidates: candidates.length },
      'Starting network scan',
    )

    const found: string[] = []
    for (let i = 0; i < candidates.length; i += SCAN_CONCURRENCY) {
      const batch = candidates.slice(i, i + SCAN_CONCURRENCY)
      const results = await Promise.allSettled(
        batch.map((url) => this._probeHost(url)),
      )
      for (const res of results) {
        if (res.status === 'fulfilled' && res.value !== null) {
          found.push(res.value)
        }
      }
    }

    logger.debug({ found: found.length }, 'Network scan complete')
    return found
  }

  /** Probe a single host URL; returns the URL if Ollama responds, else null. */
  private async _probeHost(url: string): Promise<string | null> {
    const host = new URL(url).hostname
    const open = await this._tcpProbe(host)
    if (!open) return null
    // TCP port is open — verify it is actually Ollama
    try {
      const resp = await request(`${url}/api/version`, {
        method: 'GET',
        headersTimeout: 2000,
        bodyTimeout: 2000,
        signal: AbortSignal.timeout(2000),
      })
      await resp.body.dump()
      return resp.statusCode === 200 ? url : null
    } catch {
      return null
    }
  }

  /** TCP-level port check. Returns true if the port accepts a connection. */
  private _tcpProbe(host: string): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = createConnection({ host, port: OLLAMA_PORT })
      const cleanup = (result: boolean) => {
        socket.destroy()
        resolve(result)
      }
      const timer = setTimeout(() => cleanup(false), SCAN_TIMEOUT_MS)
      socket.once('connect', () => { clearTimeout(timer); cleanup(true) })
      socket.once('error', () => { clearTimeout(timer); cleanup(false) })
      socket.once('timeout', () => cleanup(false))
      socket.setTimeout(SCAN_TIMEOUT_MS)
    })
  }

  // Virtual/tunnel interface prefixes to skip (Docker, VPN, VMware, etc.)
  private static readonly VIRTUAL_IFACE_PREFIXES = [
    'utun', 'tun', 'tap', 'ppp',
    'docker', 'veth', 'br-',
    'vmnet', 'vmenet',
    'bridge', 'awdl', 'llw',
  ]

  /** Enumerate /24 subnet prefixes from physical non-loopback IPv4 interfaces only. */
  _getLocalSubnets(): string[] {
    const subnets = new Set<string>()
    const ifaces = networkInterfaces()
    for (const [name, addrs] of Object.entries(ifaces)) {
      if (!addrs) continue
      const isVirtual = NetworkScanner.VIRTUAL_IFACE_PREFIXES.some((p) => name.startsWith(p))
      if (isVirtual) continue
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
          const parts = addr.address.split('.')
          subnets.add(`${parts[0]}.${parts[1]}.${parts[2]}`)
        }
      }
    }
    return [...subnets]
  }

  /** Build all host URLs for a /24 subnet prefix (1-254). */
  _buildCandidates(subnetPrefix: string): string[] {
    return Array.from(
      { length: 254 },
      (_, i) => `http://${subnetPrefix}.${i + 1}:${OLLAMA_PORT}`,
    )
  }

}
