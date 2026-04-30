// network-scanner.ts - Scan local subnets for Ollama nodes
import { request } from 'undici'
import { networkInterfaces } from 'node:os'
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
    try {
      const resp = await request(`${url}/api/version`, {
        method: 'GET',
        headersTimeout: SCAN_TIMEOUT_MS,
        bodyTimeout: SCAN_TIMEOUT_MS,
      })
      if (resp.statusCode === 200) {
        await resp.body.dump()
        return url
      }
      await resp.body.dump()
    } catch {
      // unreachable host — expected during scan
    }
    return null
  }

  /** Enumerate /24 subnet prefixes from all non-loopback IPv4 interfaces. */
  _getLocalSubnets(): string[] {
    const subnets = new Set<string>()
    const ifaces = networkInterfaces()
    for (const addrs of Object.values(ifaces)) {
      if (!addrs) continue
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
