import { describe, it, expect } from '@jest/globals'
import { LoadManager } from '../src/load-manager.js'

describe('LoadManager – onNodeLoadChange callback (bug-4 fix)', () => {
  it('fires with correct host and load on incrementLoad', () => {
    const events = []
    const lm = new LoadManager({
      maxConcurrentPerNode: 5,
      onNodeLoadChange: (host, load) => events.push({ host, load }),
    })

    lm.incrementLoad('http://node-a:11434')
    lm.incrementLoad('http://node-a:11434')

    expect(events).toEqual([
      { host: 'http://node-a:11434', load: 1 },
      { host: 'http://node-a:11434', load: 2 },
    ])
  })

  it('fires with correct load on decrementLoad', () => {
    const events = []
    const lm = new LoadManager({
      maxConcurrentPerNode: 5,
      onNodeLoadChange: (host, load) => events.push({ host, load }),
    })

    lm.incrementLoad('http://node-a:11434')
    events.length = 0

    lm.decrementLoad('http://node-a:11434')
    expect(events).toEqual([{ host: 'http://node-a:11434', load: 0 }])
  })

  it('does NOT fire when no callback provided', () => {
    const lm = new LoadManager({ maxConcurrentPerNode: 3 })
    expect(() => {
      lm.incrementLoad('http://node-a:11434')
      lm.decrementLoad('http://node-a:11434')
    }).not.toThrow()
  })

  it('reports independent load per node', () => {
    const events = []
    const lm = new LoadManager({
      maxConcurrentPerNode: 5,
      onNodeLoadChange: (host, load) => events.push({ host, load }),
    })

    lm.incrementLoad('http://node-a:11434')
    lm.incrementLoad('http://node-b:11434')
    lm.incrementLoad('http://node-b:11434')

    expect(events).toEqual([
      { host: 'http://node-a:11434', load: 1 },
      { host: 'http://node-b:11434', load: 1 },
      { host: 'http://node-b:11434', load: 2 },
    ])
  })

  it('callback value matches getCurrentLoad at that moment', () => {
    const snapshots = []
    const lm = new LoadManager({
      maxConcurrentPerNode: 5,
      onNodeLoadChange: (host, load) => {
        snapshots.push({ callbackLoad: load, currentLoad: lm.getCurrentLoad(host) })
      },
    })

    lm.incrementLoad('http://node-a:11434')
    lm.incrementLoad('http://node-a:11434')
    lm.decrementLoad('http://node-a:11434')

    for (const s of snapshots) {
      expect(s.callbackLoad).toBe(s.currentLoad)
    }
  })
})
