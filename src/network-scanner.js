// network-scanner.js - Scans local network for Ollama nodes
import { request } from 'undici'
import { networkInterfaces } from 'os'
import { createLogger } from './logger.js'

const logger = createLogger('scanner')

const OLLAMA_PORT = 11434
const SCAN_CONCURRENCY = 30
const PROBE_TIMEOUT_MS = 300

export class NetworkScanner {
  /**
   * Scan all local /24 subnets for Ollama nodes.
   * @returns {Promise<string[]>} list of reachable base URLs
   */
  async scanLocalNetwork() {
    const subnets = this._getLocalSubnets()
    logger.debug({ subnets }, 'Starting network scan')
    const candidates = subnets.flatMap((subnet) =>
      Array.from({ length: 254 }, (_, i) => `${subnet}.${i + 1}`),
    )

    const found = []
    for (let i = 0; i < candidates.length; i += SCAN_CONCURRENCY) {
      const batch = candidates.slice(i, i + SCAN_CONCURRENCY)
      const results = await Promise.allSettled(
        batch.map((ip) => this._probeHost(ip)),
      )
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          found.push(result.value)
        }
      }
    }

    logger.info({ found: found.length, scanned: candidates.length }, 'Network scan finished')
    return found
  }

  /**
   * Get unique /24 subnet prefixes from all local non-internal IPv4 interfaces.
   * @returns {string[]}
   * @private
   */
  _getLocalSubnets() {
    const subnets = new Set()
    const interfaces = networkInterfaces()

    for (const iface of Object.values(interfaces)) {
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) {
          const parts = addr.address.split('.')
          subnets.add(`${parts[0]}.${parts[1]}.${parts[2]}`)
        }
      }
    }

    return [...subnets]
  }

  /**
   * Probe a single host for Ollama /api/version.
   * @param {string} ip
   * @returns {Promise<string|null>} base URL if reachable, null otherwise
   * @private
   */
  async _probeHost(ip) {
    try {
      const resp = await request(
        `http://${ip}:${OLLAMA_PORT}/api/version`,
        { method: 'GET', headersTimeout: PROBE_TIMEOUT_MS, bodyTimeout: PROBE_TIMEOUT_MS },
      )
      if (resp.statusCode === 200) {
        await resp.body.dump()
        return `http://${ip}:${OLLAMA_PORT}`
      }
      await resp.body.dump()
      return null
    } catch {
      return null
    }
  }
}
