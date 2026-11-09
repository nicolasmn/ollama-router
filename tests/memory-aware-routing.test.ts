// Memory-aware co-location: scoring must not route a cold model onto a node
// where loading it would evict a hot one, and must be a no-op when no node
// memory is configured.
import { describe, it, expect } from '@jest/globals'
import { RequestRouter } from '../src/request-router.js'
import { LoadManager } from '../src/load-manager.js'
import { DiscoveryManager } from '../src/discovery-manager.js'
import { ModelInfo, ModelProfile, NodeInfo } from '../src/models.js'
import { parseNodeMemoryGb } from '../src/config.js'

const GB = 1024 ** 3
const MAC = 'http://192.168.1.20:11434'
const BOX = 'http://192.168.1.30:11434'

function makeRouter(nodeMemory: string | undefined) {
  const dm = new DiscoveryManager({ ollamaNodes: [], nodeMemory: parseNodeMemoryGb(nodeMemory) })
  ;(dm as any).getScanStatus = () => ({ inProgress: false, lastScanMs: Date.now(), lastScanAgo: 0 })
  for (const host of [MAC, BOX]) {
    const node = new NodeInfo(host)
    node.reachable = true
    for (const [name, diskGb] of [['gpt-oss:20b', 13.8], ['gemma4:e2b', 3], ['nimble-v3:9b', 9.3]] as const) {
      node.models.set(name, new ModelInfo(name, 'test', diskGb * GB, new ModelProfile({ parameters: 8, contextLength: 32_000 })))
    }
    dm.inventory.set(host, node)
  }
  // nimble is hot on the Mac: loaded and served traffic seconds ago.
  const mac = dm.inventory.get(MAC)!
  mac.models.get('nimble-v3:9b')!.lastRoutedAt = Date.now() - 10_000
  mac.loaded = {
    updatedAt: Date.now(),
    models: [{ name: 'nimble-v3:9b', size: 9.3 * GB, sizeVram: 9.3 * GB, expiresAt: Date.now() + 290_000 }],
  }
  dm.inventory.get(BOX)!.loaded = { updatedAt: Date.now(), models: [] }
  return new RequestRouter(dm, new LoadManager({ maxConcurrentPerNode: 3 }))
}

const chat = (model: string) => ({ model, messages: [{ role: 'user', content: 'hi' }] })

describe('RequestRouter — memory-aware co-location', () => {
  it('routes a big cold model to the node with room instead of evicting the hot one', async () => {
    const router = makeRouter(`${MAC}=24,${BOX}=64`)
    const result = (await router.selectForChat(chat('gpt-oss:20b'))) as any[]
    expect(result[0].nodeHost).toBe(BOX)
    const onMac = result.find((c) => c.nodeHost === MAC)
    expect(onMac.rationale.factors.find((f: any) => f.id === 'eviction').points).toBeLessThan(0)
    expect(onMac.rationale.factors.find((f: any) => f.id === 'eviction').detail).toContain('nimble-v3:9b')
  })

  it('does not penalize a small model that fits alongside the hot one', async () => {
    const router = makeRouter(`${MAC}=24,${BOX}=64`)
    const result = (await router.selectForChat(chat('gemma4:e2b'))) as any[]
    for (const c of result) {
      expect(c.rationale.factors.find((f: any) => f.id === 'eviction').points).toBe(0)
    }
  })

  it('applies no penalty anywhere when no node memory is configured', async () => {
    const router = makeRouter(undefined)
    const result = (await router.selectForChat(chat('gpt-oss:20b'))) as any[]
    for (const c of result) {
      expect(c.rationale.factors.find((f: any) => f.id === 'eviction').points).toBe(0)
    }
  })
})
