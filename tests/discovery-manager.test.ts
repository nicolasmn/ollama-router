import { describe, it, expect } from '@jest/globals'
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
