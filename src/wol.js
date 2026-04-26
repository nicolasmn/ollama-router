// wol.js - Wake-on-LAN magic packet sender
//
// MacBook WiFi WoL notes:
//   - "Wake for network access" must be enabled in Energy Saver / Battery settings
//   - Send to subnet directed broadcast (e.g. 192.168.1.255), not 255.255.255.255,
//     because WiFi APs reliably forward directed broadcasts to sleeping stations
//   - Multiple packets improve reliability (WiFi is lossy while client is sleeping)
//   - Ports 7 and 9 are both used by convention

import { createSocket } from 'node:dgram'
import { execFile } from 'node:child_process'

const WOL_PORT = 9
const PACKET_COUNT = 6
const PACKET_INTERVAL_MS = 100

/**
 * Read the MAC address for a given IPv4 address from the OS ARP table.
 * The OS populates the ARP cache automatically when any TCP connection is made
 * to the host, so this works without any extra setup as long as the node was
 * reachable at least once recently.
 *
 * Uses `arp -an` (dump all entries) rather than `arp -n <ip>` because the
 * single-host form returns a non-zero exit code when the entry is missing,
 * and behaves inconsistently across macOS versions.
 *
 * Works on macOS and Linux. Returns null if the IP is not in the ARP cache.
 * @param {string} ip
 * @returns {Promise<string|null>}
 */
export function arpLookup(ip) {
  // Loopback addresses never have ARP entries
  if (ip === 'localhost' || ip.startsWith('127.') || ip === '::1') {
    return Promise.resolve(null)
  }

  return new Promise((resolve) => {
    // execFile prevents shell injection — ip is passed as a separate arg.
    // Use arp -n <ip> (single-host lookup). On macOS it exits non-zero when
    // the entry is missing but still prints output, so we check stdout too.
    execFile('arp', ['-n', ip], { timeout: 3000 }, (err, stdout) => {
      if (!stdout) {
        resolve(null)
        return
      }
      // macOS output: "? (192.168.1.10) at e2:d0:b1:ed:12:6 on en0 ..."
      // Linux output: "192.168.1.10  ether  e2:d0:b1:ed:12:6  C  eth0"
      // Octets may be 1 or 2 hex digits on macOS (no leading zero).
      const macMatch = stdout.match(/([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})/i)
      if (!macMatch) {
        resolve(null)
        return
      }
      // Normalize: zero-pad each octet to 2 digits
      const normalized = macMatch[1]
        .split(':')
        .map((o) => o.padStart(2, '0'))
        .join(':')
        .toLowerCase()
      resolve(normalized)
    })
  })
}

/**
 * Parse and normalize a MAC address string into 6 bytes.
 * Accepts colons, dashes, or no separator.
 * @param {string} mac
 * @returns {number[]} array of 6 byte values
 */
function parseMac(mac) {
  const hex = mac.replace(/[:-]/g, '')
  if (!/^[0-9a-fA-F]{12}$/.test(hex)) {
    throw new Error(`Invalid MAC address: ${mac}`)
  }
  const bytes = []
  for (let i = 0; i < 12; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16))
  }
  return bytes
}

/**
 * Build the 102-byte WoL magic packet for a given MAC address.
 * Structure: 6x 0xFF + MAC repeated 16 times
 * @param {number[]} macBytes
 * @returns {Buffer}
 */
function buildMagicPacket(macBytes) {
  const packet = Buffer.alloc(102)
  // 6 bytes of 0xFF
  packet.fill(0xff, 0, 6)
  // MAC repeated 16 times
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 6; j++) {
      packet[6 + i * 6 + j] = macBytes[j]
    }
  }
  return packet
}

/**
 * Derive the /24 subnet broadcast address from an IP string.
 * e.g. '192.168.1.50' -> '192.168.1.255'
 * Falls back to '255.255.255.255' for non-IPv4 inputs.
 * @param {string} ip
 * @returns {string}
 */
function subnetBroadcast(ip) {
  const parts = ip.split('.')
  if (parts.length !== 4) return '255.255.255.255'
  return `${parts[0]}.${parts[1]}.${parts[2]}.255`
}

/**
 * Extract hostname/IP from a node host URL.
 * e.g. 'http://192.168.1.10:11434' -> '192.168.1.10'
 * @param {string} nodeHost
 * @returns {string}
 */
function extractIp(nodeHost) {
  try {
    const url = nodeHost.startsWith('http') ? nodeHost : `http://${nodeHost}`
    return new URL(url).hostname
  } catch {
    return nodeHost
  }
}

/**
 * Send WoL magic packets to wake a device.
 *
 * Sends `count` packets at `intervalMs` intervals to both the subnet directed
 * broadcast and 255.255.255.255 for maximum WiFi reliability.
 *
 * @param {string} mac - MAC address of target device
 * @param {object} [opts]
 * @param {string} [opts.nodeHost] - node URL used to derive broadcast address
 * @param {string} [opts.broadcastAddress] - explicit broadcast address (overrides nodeHost derivation)
 * @param {number} [opts.port] - UDP port (default: 9)
 * @param {number} [opts.count] - number of packets to send (default: 6)
 * @param {number} [opts.intervalMs] - interval between packets in ms (default: 100)
 * @returns {Promise<void>}
 */
export function sendWakeOnLan(mac, opts = {}) {
  const macBytes = parseMac(mac)
  const packet = buildMagicPacket(macBytes)

  const port = opts.port ?? WOL_PORT
  const count = opts.count ?? PACKET_COUNT
  const intervalMs = opts.intervalMs ?? PACKET_INTERVAL_MS

  // Determine broadcast targets
  const targets = new Set(['255.255.255.255'])
  if (opts.broadcastAddress) {
    targets.add(opts.broadcastAddress)
  } else if (opts.nodeHost) {
    const ip = extractIp(opts.nodeHost)
    const directed = subnetBroadcast(ip)
    if (directed !== '255.255.255.255') {
      targets.add(directed)
    }
  }

  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4')

    socket.once('error', (err) => {
      socket.close()
      reject(err)
    })

    socket.bind(() => {
      socket.setBroadcast(true)

      const broadcastList = [...targets]
      let sent = 0
      const total = count * broadcastList.length

      const send = () => {
        for (const address of broadcastList) {
          socket.send(packet, 0, packet.length, port, address, (err) => {
            if (err) {
              socket.close()
              reject(err)
              return
            }
            sent++
            if (sent === total) {
              socket.close()
              resolve()
            }
          })
        }
      }

      // Send first batch immediately, then repeat with interval
      send()
      let remaining = count - 1
      const interval = setInterval(() => {
        send()
        remaining--
        if (remaining <= 0) clearInterval(interval)
      }, intervalMs)
    })
  })
}
