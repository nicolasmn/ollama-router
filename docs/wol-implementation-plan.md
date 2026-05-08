# Wake-on-LAN Implementation Plan

## Goal

Auto-wake sleeping MacBooks (WiFi) when an inbound request has no live candidates.
- MACs are learned automatically from ARP on successful node probes — no manual config
- MACs are persisted across restarts in `data/model-metrics.json`
- WoL is only triggered by real inbound requests, never background probes
- The request waits up to 30 s for the node to come back before returning 503

## Constraints

- No external npm dependencies
- No mDNS, no SSH, no manual MAC entry
- TypeScript project, compiled via `tsc` to `dist/`
- Existing tests must stay green

---

## Phase 1 — `src/wol.ts` (new file)

Create this file from scratch. Three exports:

### `extractIp(nodeHost: string): string`

Parse the IP/hostname out of an `http://…` URL:

```ts
import { URL } from 'node:url'
export function extractIp(nodeHost: string): string {
  return new URL(nodeHost).hostname
}
```

### `arpLookup(ip: string): Promise<string | null>`

- Return `null` immediately for loopback: `ip === 'localhost' || ip.startsWith('127.') || ip === '::1'`
- Run `execFile('arp', ['-n', ip])` (single-host form — **not** `-an`)
- Parse the line that matches `/ at ([0-9a-f:]+) /i`
- Normalize unpadded octets: `.split(':').map(o => o.padStart(2, '0')).join(':').toLowerCase()`
- Return the MAC or `null`
- macOS `arp -n` exits with a non-zero code when the IP is not in the cache but still prints a line — catch the error and try to parse stdout anyway before returning `null`

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execFileAsync = promisify(execFile)

export async function arpLookup(ip: string): Promise<string | null> {
  if (ip === 'localhost' || ip.startsWith('127.') || ip === '::1') return null
  try {
    const { stdout } = await execFileAsync('arp', ['-n', ip], { timeout: 3000 })
    return parseMac(stdout)
  } catch (err: unknown) {
    // arp exits non-zero when IP not cached, but may still print the MAC
    const stdout = (err as { stdout?: string }).stdout ?? ''
    return parseMac(stdout)
  }
}

function parseMac(output: string): string | null {
  const m = output.match(/ at ([0-9a-f:]+)/i)
  if (!m) return null
  const raw = m[1]
  if (raw === '(incomplete)') return null
  return raw.split(':').map(o => o.padStart(2, '0')).join(':').toLowerCase()
}
```

### `sendWakeOnLan(mac: string, opts?: { nodeHost?: string }): Promise<void>`

- Build 102-byte magic packet: 6 bytes `0xFF` followed by the 6-byte MAC repeated 16 times
- Derive directed subnet broadcast from `opts.nodeHost` (e.g. `192.168.1.10` → `192.168.1.255`)
- Send 6 UDP packets to **both** `255.255.255.255` AND the subnet broadcast, port 9
- Use `node:dgram`, set `socket.setBroadcast(true)`

```ts
import * as dgram from 'node:dgram'

export function sendWakeOnLan(mac: string, opts: { nodeHost?: string } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const macBytes = mac.split(':').map(h => parseInt(h, 16))
    const buf = Buffer.alloc(102)
    buf.fill(0xff, 0, 6)
    for (let i = 0; i < 16; i++) macBytes.forEach((b, j) => buf.writeUInt8(b, 6 + i * 6 + j))

    const targets = ['255.255.255.255']
    if (opts.nodeHost) {
      try {
        const ip = new URL(opts.nodeHost).hostname
        const parts = ip.split('.')
        if (parts.length === 4) {
          parts[3] = '255'
          targets.push(parts.join('.'))
        }
      } catch { /* ignore */ }
    }

    const sock = dgram.createSocket('udp4')
    sock.bind(() => {
      sock.setBroadcast(true)
      let pending = targets.length * 6
      const done = (err?: Error | null) => {
        if (err && pending > 0) { pending = 0; sock.close(); reject(err); return }
        if (--pending === 0) { sock.close(); resolve() }
      }
      for (const target of targets) {
        for (let i = 0; i < 6; i++) sock.send(buf, 0, buf.length, 9, target, done)
      }
    })
  })
}
```

---

## Phase 2 — `src/models.ts`

Add `mac: string | null = null` to the `NodeInfo` class and `NodeInfoJSON` interface:

```ts
// In NodeInfoJSON interface
mac: string | null

// In NodeInfo class — add field declaration
mac: string | null

// In NodeInfo constructor
this.mac = null
```

---

## Phase 3 — `src/metrics-store.ts`

### `PersistedFile` interface

Add optional field:

```ts
nodeMacs?: Record<string, string>
```

### `LoadedData` interface

Add:

```ts
nodeMacs: Map<string, string>
```

### `loadMetrics`

After parsing `metrics`, parse `nodeMacs`:

```ts
const nodeMacs = new Map<string, string>()
if (typeof parsed.nodeMacs === 'object' && parsed.nodeMacs !== null) {
  for (const [host, mac] of Object.entries(parsed.nodeMacs)) {
    if (typeof mac === 'string') nodeMacs.set(host, mac)
  }
}
return { knownNodes, metrics, nodeMacs }
```

Also update the catch/default return:

```ts
return { knownNodes: [], metrics: new Map(), nodeMacs: new Map() }
```

### `saveMetrics`

Change the `nodes` parameter type to accept `mac`:

```ts
nodes: Map<string, Pick<NodeInfo, 'models' | 'mac'>>
```

Before building `output`, collect macs:

```ts
const nodeMacsOutput: Record<string, string> = {}
for (const [host, node] of nodes) {
  if (node.mac) nodeMacsOutput[host] = node.mac
}
```

Include in `output`:

```ts
const output: PersistedFile = {
  knownNodes: Array.from(nodes.keys()),
  metrics: metricsOutput,
  nodeMacs: nodeMacsOutput,
}
```

### `MetricsStore.persist`

Update parameter type to match:

```ts
persist(nodes: Map<string, Pick<NodeInfo, 'models' | 'mac'>>): void {
  saveMetrics(this.filePath, nodes)
}
```

---

## Phase 4 — `src/discovery-manager.ts`

### Imports to add

```ts
import { arpLookup, sendWakeOnLan, extractIp } from './wol.js'
import type { AnalysisResult } from './request-analyzer.js'
```

### Constructor additions

Declare new fields on the class:

```ts
private _wolCooldowns: Map<string, number>
private _wakeProbes: Map<string, NodeJS.Timeout>
```

Initialize in constructor body:

```ts
this._wolCooldowns = new Map()
this._wakeProbes = new Map()
```

### `initialize()`

After `_applyLoadedMetrics`, call:

```ts
this._applyLoadedMacs(loadedData.nodeMacs)
```

(Destructure `nodeMacs` from `this.metricsStore.load()` alongside existing `knownNodes` and `metrics`.)

### New private method: `_applyLoadedMacs`

```ts
private _applyLoadedMacs(macs: Map<string, string>): void {
  for (const [host, mac] of macs) {
    const node = this.inventory.get(host)
    if (node) node.mac = mac
  }
}
```

### `_probeNode()` — ARP lookup after successful probe

After the block that sets `node.reachable = true`, `node.lastSeen`, `node.failures = 0` — add:

```ts
// Learn MAC via ARP while the node is known to be up
try {
  const ip = extractIp(host)
  const mac = await arpLookup(ip)
  if (mac && mac !== node.mac) {
    node.mac = mac
    logger.debug({ host, mac }, 'Learned MAC address via ARP')
  }
} catch {
  // ARP lookup failure is non-fatal
}
```

### `stopPeriodicProbe()`

Add cleanup for wake probes:

```ts
for (const timer of this._wakeProbes.values()) clearInterval(timer)
this._wakeProbes.clear()
```

### New public method: `tryWakeNodesForRequest`

```ts
tryWakeNodesForRequest(model: string, analysis: AnalysisResult): boolean {
  const isVirtual = ['auto', 'auto-fast', 'auto-think'].includes(model)
  let triggered = false
  for (const [host, node] of this.inventory) {
    if (node.reachable) continue
    if (this._isLocalhost(host)) continue
    if (!node.mac) continue
    if (!this._offlineNodeCouldServe(node, model, analysis, isVirtual)) continue
    this._triggerWol(host, node.mac)
    triggered = true
  }
  return triggered
}
```

### New private method: `_offlineNodeCouldServe`

```ts
private _offlineNodeCouldServe(
  node: NodeInfo,
  model: string,
  analysis: AnalysisResult,
  isVirtual: boolean,
): boolean {
  if (node.models.size === 0) return false  // no history — unknown capability
  if (!isVirtual) return node.models.has(model)

  for (const modelInfo of node.models.values()) {
    const { profile } = modelInfo
    if (analysis.needsEmbeddings && !profile.isEmbedding) continue
    if (!analysis.needsEmbeddings && profile.isEmbedding) continue
    if (analysis.needsTools && !profile.supportsTools) continue
    if (analysis.needsVision && !profile.supportsVision) continue
    if (model === 'auto-think' && !profile.supportsThinking) continue
    return true  // at least one model on this node matches
  }
  return false
}
```

### New private method: `_triggerWol`

```ts
private _triggerWol(nodeHost: string, mac: string): void {
  const cooldown = 60_000
  const last = this._wolCooldowns.get(nodeHost) ?? 0
  if (Date.now() - last < cooldown) {
    logger.debug({ nodeHost }, 'WoL skipped — cooldown active')
    return
  }
  this._wolCooldowns.set(nodeHost, Date.now())
  logger.info({ nodeHost, mac }, 'Sending Wake-on-LAN packet')
  sendWakeOnLan(mac, { nodeHost }).catch((err: Error) => {
    logger.warn({ nodeHost, err: err.message }, 'WoL send failed')
  })
  this._startWakeProbe(nodeHost)
}
```

### New private method: `_startWakeProbe`

```ts
private _startWakeProbe(nodeHost: string): void {
  if (this._wakeProbes.has(nodeHost)) return  // already polling
  const started = Date.now()
  const MAX_PROBE_MS = 120_000
  const INTERVAL_MS = 3_000
  const timer = setInterval(async () => {
    if (Date.now() - started > MAX_PROBE_MS) {
      clearInterval(timer)
      this._wakeProbes.delete(nodeHost)
      logger.warn({ nodeHost }, 'Wake probe timed out — node did not respond')
      return
    }
    try {
      await this._probeNode(nodeHost)
      const node = this.inventory.get(nodeHost)
      if (node?.reachable) {
        clearInterval(timer)
        this._wakeProbes.delete(nodeHost)
        logger.info({ nodeHost }, 'Node came back online after WoL')
        this.inventoryUpdateHandler?.(this.inventory)
      }
    } catch {
      // keep polling
    }
  }, INTERVAL_MS)
  this._wakeProbes.set(nodeHost, timer)
}
```

---

## Phase 5 — `src/request-router.ts`

### Import update

Add `AnalysisResult` to the existing import from `./request-analyzer.js`:

```ts
import type { AnalysisResult } from './request-analyzer.js'
```

### New private method: `_waitForWol`

Add after `_performOnRequestScan`:

```ts
private async _waitForWol(
  model: string,
  analysis: AnalysisResult,
  reqBody: Record<string, unknown>,
  maxWaitMs = 30_000,
): Promise<RoutingCandidate | RoutingCandidate[] | null> {
  const triggered = this.discovery.tryWakeNodesForRequest(model, analysis)
  if (!triggered) return null

  logger.info({ model }, 'WoL triggered — waiting for node to come back online')
  const deadline = Date.now() + maxWaitMs
  const POLL_MS = 2_000

  while (Date.now() < deadline) {
    await new Promise<void>(resolve => setTimeout(resolve, POLL_MS))
    const result = this._selectCandidates(model, analysis, reqBody)
    if (result !== null && !(Array.isArray(result) && result.length === 0)) {
      logger.info({ model }, 'Node online — routing request after WoL')
      return result
    }
  }

  logger.warn({ model }, 'Node did not come back online within wait window')
  return null
}
```

### Patch `selectForChat`, `selectForEmbeddings`, `selectForResponses`

In each method, after the `_selectCandidates` call returns `null`, try WoL:

```ts
// Before (example for selectForChat):
return this._selectCandidates(model, analysis, reqBody)

// After:
const result = this._selectCandidates(model, analysis, reqBody)
if (result !== null && !(Array.isArray(result) && result.length === 0)) return result
return this._waitForWol(model, analysis, reqBody)
```

---

## Architecture Notes

- `_selectConcrete` already returns `null` (not throws) when a model exists on an offline node — so the WoL path will be entered correctly for concrete model names
- `_waitForWol` polls every 2 s; `_startWakeProbe` polls every 3 s → node online will be detected within ~4 s after first probe succeeds
- ARP lookup happens only on successful probe (node online) — so MACs are learned when nodes are first up and re-learned after each wake
- The 60 s cooldown is per-node, so multiple concurrent requests don't spam WoL packets

---

## Existing Files Modified

| File | Change |
|---|---|
| `src/wol.ts` | **New file** |
| `src/models.ts` | Add `mac` field to `NodeInfo` + `NodeInfoJSON` |
| `src/metrics-store.ts` | Add `nodeMacs` to persist/load |
| `src/discovery-manager.ts` | ARP lookup, WoL methods, persistence restore |
| `src/request-router.ts` | `_waitForWol` + hook into select methods |

No route files need changes — the select methods are already `async` and `selectCandidatesOrHandleError` already `await`s the `selectFn`.

---

## Verification Steps

```bash
# 1. TypeScript compile — must be error-free
npm run build

# 2. Existing tests — must all pass
npm test -- --no-coverage

# 3. Manual smoke test (node offline):
# - Shut down a MacBook on the same network
# - POST /v1/chat/completions with a model that was on that node
# - Observe in logs: "Sending Wake-on-LAN packet" → "Node came back online after WoL"
# - Response should arrive within ~30 s (not 503)

# 4. Manual smoke test (node has no MAC yet):
# - Remove nodeMacs from data/model-metrics.json
# - Expect: WoL not triggered, immediate 503 returned

# 5. Cooldown test:
# - Send two consecutive requests within 60 s to same offline node
# - Expect: second request logs "WoL skipped — cooldown active"
```
