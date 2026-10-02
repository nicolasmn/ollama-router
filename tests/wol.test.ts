import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import type { AnalysisResult } from '../src/request-analyzer.js'
import type { NodeInfo as NodeInfoType, ModelInfo as ModelInfoType } from '../src/models.js'

// ── Fake timers — prevents DiscoveryManager setInterval from leaking ─────────
jest.useFakeTimers()

// ── Mock wol.js before any dynamic imports that pull it in ─────────────────────
const mockSendWakeOnLan = jest
  .fn<(mac: string) => Promise<void>>()
  .mockResolvedValue(undefined)

jest.unstable_mockModule('../src/wol.js', () => ({
  sendWakeOnLan: mockSendWakeOnLan,
  arpLookup: jest.fn<() => Promise<string | null>>().mockResolvedValue(null),
  extractIp: (host: string) => new URL(host).hostname,
}))

// ── Dynamic imports AFTER mock registration ────────────────────────────
const { DiscoveryManager } = await import('../src/discovery-manager.js')
const { NodeInfo, ModelInfo, ModelProfile } = await import('../src/models.js')

// ── Helpers ────────────────────────────────────────────────────────────────────────────────
function makeAnalysis(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    endpointType: 'chat',
    needsEmbeddings: false,
    needsTools: false,
    needsVision: false,
    needsAudio: false,
    preferFast: false,
    preferReasoning: false,
    hasCodeSignals: false,
    messageCount: 1,
    estimatedInputTokens: 10,
    maxOutputTokens: 0,
    isStreaming: false,
    ...overrides,
  }
}

function makeNode(
  host: string,
  opts: { reachable?: boolean; mac?: string; models?: Record<string, Partial<ModelInfoType>> } = {},
): NodeInfoType {
  const n = new NodeInfo(host)
  n.reachable = opts.reachable ?? false
  if (opts.mac) n.mac = opts.mac
  for (const [name, partial] of Object.entries(opts.models ?? {})) {
    const m = new ModelInfo(name, '', 0, new ModelProfile())
    Object.assign(m, partial)
    n.models.set(name, m)
  }
  return n
}

// ── tryWakeNodesForRequest ────────────────────────────────────────────────────────────
describe('DiscoveryManager.tryWakeNodesForRequest', () => {
  beforeEach(() => { mockSendWakeOnLan.mockClear() })

  it('returns false when no offline nodes exist', () => {
    const dm = new DiscoveryManager({ ollamaNodes: [] })
    dm.inventory.set('http://192.168.1.10:11434', makeNode('http://192.168.1.10:11434', { reachable: true, mac: 'aa:bb:cc:dd:ee:ff' }))
    expect(dm.tryWakeNodesForRequest('llama3', makeAnalysis())).toBe(false)
  })

  it('returns false when offline node has no MAC', () => {
    const dm = new DiscoveryManager({ ollamaNodes: [] })
    dm.inventory.set('http://192.168.1.10:11434', makeNode('http://192.168.1.10:11434', { reachable: false, models: { llama3: {} } }))
    expect(dm.tryWakeNodesForRequest('llama3', makeAnalysis())).toBe(false)
  })

  it('returns false when offline node has no model history', () => {
    const dm = new DiscoveryManager({ ollamaNodes: [] })
    dm.inventory.set('http://192.168.1.10:11434', makeNode('http://192.168.1.10:11434', { reachable: false, mac: 'aa:bb:cc:dd:ee:ff' }))
    expect(dm.tryWakeNodesForRequest('llama3', makeAnalysis())).toBe(false)
  })

  it('returns false when offline node does not have the requested concrete model', () => {
    const dm = new DiscoveryManager({ ollamaNodes: [] })
    dm.inventory.set('http://192.168.1.10:11434', makeNode('http://192.168.1.10:11434', { reachable: false, mac: 'aa:bb:cc:dd:ee:ff', models: { 'other-model': {} } }))
    expect(dm.tryWakeNodesForRequest('llama3', makeAnalysis())).toBe(false)
  })

  it('skips localhost even with MAC+model', () => {
    const dm = new DiscoveryManager({ ollamaNodes: [] })
    dm.inventory.set('http://localhost:11434', makeNode('http://localhost:11434', { reachable: false, mac: 'aa:bb:cc:dd:ee:ff', models: { llama3: {} } }))
    expect(dm.tryWakeNodesForRequest('llama3', makeAnalysis())).toBe(false)
  })

  it('triggers WoL and returns true for matching offline network node', () => {
    const dm = new DiscoveryManager({ ollamaNodes: [] })
    dm.inventory.set('http://192.168.1.10:11434', makeNode('http://192.168.1.10:11434', { reachable: false, mac: 'aa:bb:cc:dd:ee:ff', models: { llama3: {} } }))
    expect(dm.tryWakeNodesForRequest('llama3', makeAnalysis())).toBe(true)
    expect(mockSendWakeOnLan).toHaveBeenCalledTimes(1)
    expect(mockSendWakeOnLan).toHaveBeenCalledWith('aa:bb:cc:dd:ee:ff')
  })

  it('respects cooldown — does not retrigger within 60s', () => {
    const dm = new DiscoveryManager({ ollamaNodes: [] })
    dm.inventory.set('http://192.168.1.10:11434', makeNode('http://192.168.1.10:11434', { reachable: false, mac: 'aa:bb:cc:dd:ee:ff', models: { llama3: {} } }))
    dm.tryWakeNodesForRequest('llama3', makeAnalysis())
    dm.tryWakeNodesForRequest('llama3', makeAnalysis())
    expect(mockSendWakeOnLan).toHaveBeenCalledTimes(1)
  })
})

// ── mergeInventory MAC preservation ──────────────────────────────────────────────
describe('DiscoveryManager.mergeInventory — MAC preservation', () => {
  it('preserves learned MAC when merging fresh node without MAC', () => {
    const dm = new DiscoveryManager({ ollamaNodes: [] })
    dm.inventory.set('http://192.168.1.10:11434', makeNode('http://192.168.1.10:11434', { reachable: true, mac: 'aa:bb:cc:dd:ee:ff' }))
    const freshNodes = new Map<string, NodeInfoType>()
    freshNodes.set('http://192.168.1.10:11434', makeNode('http://192.168.1.10:11434', { reachable: true }))
    dm.mergeInventory(freshNodes)
    expect(dm.inventory.get('http://192.168.1.10:11434')?.mac).toBe('aa:bb:cc:dd:ee:ff')
  })

  it('does not overwrite MAC if freshNode already has one', () => {
    const dm = new DiscoveryManager({ ollamaNodes: [] })
    dm.inventory.set('http://192.168.1.10:11434', makeNode('http://192.168.1.10:11434', { reachable: true, mac: 'aa:bb:cc:dd:ee:ff' }))
    const freshNodes = new Map<string, NodeInfoType>()
    freshNodes.set('http://192.168.1.10:11434', makeNode('http://192.168.1.10:11434', { reachable: true, mac: '11:22:33:44:55:66' }))
    dm.mergeInventory(freshNodes)
    expect(dm.inventory.get('http://192.168.1.10:11434')?.mac).toBe('11:22:33:44:55:66')
  })
})
