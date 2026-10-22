import { describe, it, expect, jest } from '@jest/globals'
import { DiscoveryManager } from '../src/discovery-manager.js'
import { NodeInfo } from '../src/models.js'

describe('DiscoveryManager.buildModelProfile', () => {
  const dm = new DiscoveryManager({ ollamaNodes: [] })

  it('parses capabilities from /api/show response', () => {
    const profile = dm.buildModelProfile({
      capabilities: ['tools', 'vision'],
      model_info: { 'general.parameter_count': 26e9 },
    })
    expect(profile.supportsTools).toBe(true)
    expect(profile.supportsVision).toBe(true)
    expect(profile.parameters).toBeCloseTo(26, 0)
  })

  it('handles empty capabilities', () => {
    const profile = dm.buildModelProfile({ capabilities: [], model_info: {} })
    expect(profile.supportsTools).toBe(false)
    expect(profile.supportsVision).toBe(false)
    expect(profile.isEmbedding).toBe(false)
  })

  it('detects embedding models', () => {
    const profile = dm.buildModelProfile({ capabilities: ['embedding'] })
    expect(profile.isEmbedding).toBe(true)
  })

  it('detects thinking models', () => {
    const profile = dm.buildModelProfile({ capabilities: ['thinking'] })
    expect(profile.supportsThinking).toBe(true)
  })

  it('extracts context length from model_info', () => {
    const profile = dm.buildModelProfile({
      capabilities: [],
      model_info: { 'llama.context_length': 131072 },
    })
    expect(profile.contextLength).toBe(131072)
  })

  it('defaults contextLength to 4096 when missing', () => {
    const profile = dm.buildModelProfile(null)
    expect(profile.contextLength).toBe(4096)
    expect(profile.parameters).toBe(0)
  })
})

describe('DiscoveryManager - Network Connectivity', () => {
  it('detects localhost-only configuration', () => {
    const dm = new DiscoveryManager({
      ollamaNodes: ['localhost:11434'],
      networkScanInterval: 60000,
      networkScanIntervalActive: 1800000,
    })
    const localhostNode = new NodeInfo('http://localhost:11434')
    dm.inventory.set('http://localhost:11434', localhostNode)
    expect(dm.isConnectedToNetworkNodes()).toBe(false)
  })

  it('detects network node presence', () => {
    const dm = new DiscoveryManager({
      ollamaNodes: ['192.168.1.10:11434'],
      networkScanInterval: 60000,
      networkScanIntervalActive: 1800000,
    })
    const networkNode = new NodeInfo('http://192.168.1.10:11434')
    dm.inventory.set('http://192.168.1.10:11434', networkNode)
    expect(dm.isConnectedToNetworkNodes()).toBe(true)
  })

  it('determines correct scan interval for localhost-only', () => {
    const dm = new DiscoveryManager({
      ollamaNodes: ['localhost:11434'],
      networkScanInterval: 60000,
      networkScanIntervalActive: 1800000,
    })
    const localhostNode = new NodeInfo('http://localhost:11434')
    dm.inventory.set('http://localhost:11434', localhostNode)
    expect(dm._determineNextScanInterval()).toBe(60000)
  })

  it('determines correct scan interval for network nodes', () => {
    const dm = new DiscoveryManager({
      ollamaNodes: ['192.168.1.10:11434'],
      networkScanInterval: 60000,
      networkScanIntervalActive: 1800000,
    })
    const networkNode = new NodeInfo('http://192.168.1.10:11434')
    dm.inventory.set('http://192.168.1.10:11434', networkNode)
    expect(dm._determineNextScanInterval()).toBe(1800000)
  })

  it('tracks scan status correctly', () => {
    const dm = new DiscoveryManager({ ollamaNodes: [] })
    const status = dm.getScanStatus()
    expect(status.inProgress).toBe(false)
    expect(status.lastScanMs).toBe(0)
    expect(status.lastScanAgo).toBe(-1)
  })

  it('recognizes various localhost formats', () => {
    const dm = new DiscoveryManager({ ollamaNodes: [] })
    expect(dm._isLocalhost('http://localhost:11434')).toBe(true)
    expect(dm._isLocalhost('http://127.0.0.1:11434')).toBe(true)
    expect(dm._isLocalhost('http://[::1]:11434')).toBe(true)
    expect(dm._isLocalhost('http://192.168.1.1:11434')).toBe(false)
    expect(dm._isLocalhost('http://example.com:11434')).toBe(false)
  })
})

describe('DiscoveryManager._isLocalhost — self-address detection', () => {
  /**
   * Build a DiscoveryManager whose selfAddresses field is seeded with
   * a controlled set of IPs, bypassing the real networkInterfaces() call.
   * We reach into the private field directly (TypeScript cast) because
   * the logic is pure and testable without a full OS mock.
   *
   * IPs are stored without brackets — matching networkInterfaces() output.
   * URL.hostname returns '[fd00::1]' for IPv6 literals (RFC 3986 bracket
   * notation); _isLocalhost strips the brackets before the Set lookup.
   */
  function makeWithSelfAddresses(ips: string[]): DiscoveryManager {
    const dm = new DiscoveryManager({ ollamaNodes: [] })
    ;(dm as unknown as { selfAddresses: Set<string> }).selfAddresses = new Set(ips)
    return dm
  }

  it('returns true for own LAN IPv4 (the bug scenario)', () => {
    const dm = makeWithSelfAddresses(['192.168.178.23'])
    expect(dm._isLocalhost('http://192.168.178.23:11434')).toBe(true)
  })

  it('returns true for own LAN IPv4 without port', () => {
    const dm = makeWithSelfAddresses(['10.0.0.5'])
    expect(dm._isLocalhost('http://10.0.0.5')).toBe(true)
  })

  it('returns true for own IPv6 LAN address (brackets stripped from URL.hostname)', () => {
    // networkInterfaces() stores 'fd00::1'; URL.hostname returns '[fd00::1]'
    // _isLocalhost strips the brackets before the Set lookup
    const dm = makeWithSelfAddresses(['fd00::1'])
    expect(dm._isLocalhost('http://[fd00::1]:11434')).toBe(true)
  })

  it('returns false for a different machine on the same subnet', () => {
    const dm = makeWithSelfAddresses(['192.168.178.23'])
    expect(dm._isLocalhost('http://192.168.178.42:11434')).toBe(false)
  })

  it('returns false when selfAddresses is empty', () => {
    const dm = makeWithSelfAddresses([])
    expect(dm._isLocalhost('http://192.168.1.1:11434')).toBe(false)
  })

  it('handles malformed URL without throwing', () => {
    const dm = makeWithSelfAddresses(['192.168.1.1'])
    expect(() => dm._isLocalhost('not-a-url')).not.toThrow()
    expect(dm._isLocalhost('not-a-url')).toBe(false)
  })

  it('isConnectedToNetworkNodes returns false when only own LAN IP is in inventory', () => {
    const dm = makeWithSelfAddresses(['192.168.178.23'])
    dm.inventory.set('http://192.168.178.23:11434', new NodeInfo('http://192.168.178.23:11434'))
    expect(dm.isConnectedToNetworkNodes()).toBe(false)
  })

  it('isConnectedToNetworkNodes returns true when another machine is in inventory', () => {
    const dm = makeWithSelfAddresses(['192.168.178.23'])
    dm.inventory.set('http://192.168.178.23:11434', new NodeInfo('http://192.168.178.23:11434'))
    dm.inventory.set('http://192.168.178.42:11434', new NodeInfo('http://192.168.178.42:11434'))
    expect(dm.isConnectedToNetworkNodes()).toBe(true)
  })
})

describe('DiscoveryManager.removeNode', () => {
  function makeManager(...hosts: string[]) {
    const dm = new DiscoveryManager({ ollamaNodes: [] })
    for (const host of hosts) dm.inventory.set(host, new NodeInfo(host))
    return dm
  }

  it('returns false for unknown host', () => {
    const dm = makeManager('http://node-a:11434')
    expect(dm.removeNode('http://unknown:11434')).toBe(false)
    expect(dm.inventory.size).toBe(1)
  })

  it('removes the node and returns true', () => {
    const dm = makeManager('http://node-a:11434', 'http://node-b:11434')
    expect(dm.removeNode('http://node-a:11434')).toBe(true)
    expect(dm.inventory.has('http://node-a:11434')).toBe(false)
    expect(dm.inventory.size).toBe(1)
  })

  it('leaves other nodes intact', () => {
    const dm = makeManager('http://node-a:11434', 'http://node-b:11434')
    dm.removeNode('http://node-a:11434')
    expect(dm.inventory.has('http://node-b:11434')).toBe(true)
  })

  it('is idempotent — second call returns false', () => {
    const dm = makeManager('http://node-a:11434')
    expect(dm.removeNode('http://node-a:11434')).toBe(true)
    expect(dm.removeNode('http://node-a:11434')).toBe(false)
  })
})

describe('DiscoveryManager.persistMetrics', () => {
  it('is a no-op when no metricsFile is configured', () => {
    const dm = new DiscoveryManager({ ollamaNodes: [] })
    expect(() => dm.persistMetrics()).not.toThrow()
  })

  it('calls MetricsStore.persist with current inventory', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const tmp = mkdtempSync(join(tmpdir(), 'dm-persist-test-'))
    const metricsFile = join(tmp, 'metrics.json')
    try {
      const dm = new DiscoveryManager({
        ollamaNodes: ['http://node-a:11434'],
        metricsFile,
      })
      expect(() => dm.persistMetrics()).not.toThrow()
      const { readFileSync } = await import('node:fs')
      const saved = JSON.parse(readFileSync(metricsFile, 'utf8'))
      expect(saved.knownNodes).toContain('http://node-a:11434')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
