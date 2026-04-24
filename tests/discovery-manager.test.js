import { describe, it, expect } from '@jest/globals'
import { DiscoveryManager } from '../src/discovery-manager.js'

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
