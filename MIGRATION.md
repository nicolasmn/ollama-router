# TypeScript Migration Plan

Incremental port of the codebase to TypeScript. Each commit in this PR ticks one checkbox below.

**Runtime**: `tsx` — no compile step, types stripped at runtime, fast Docker starts  
**Type-check**: `tsc --noEmit` — CI gate, never blocks runtime  
**Tests**: `ts-jest` (ESM mode)

JS files remain importable throughout via `allowJs: true` — tests stay green at every commit.

---

## Phase 0 — Tooling bootstrap ✅
## Phase 1 — Core types ✅
## Phase 2 — Utilities ✅
## Phase 3 — Managers ✅
## Phase 4 — Core routing ✅
## Phase 5 — Routes ✅
## Phase 6 — Entry point ✅

## Phase 7 — Tests ✅
- [x] 7.1 `tests/load-manager.test.ts`
- [x] 7.2 `tests/load-manager-callbacks.test.ts`
- [x] 7.3 `tests/request-history.test.ts`
- [x] 7.4 `tests/request-analyzer.test.ts`
- [x] 7.5 `tests/metrics-store.test.ts`
- [x] 7.6 `tests/request-router.test.ts`
- [x] 7.7 `tests/discovery-manager.test.ts`
- [x] 7.8 `tests/discovery-manager-telemetry.test.ts`
- [ ] 7.9 `tests/pass-through-routes.test.ts` (integration, read source first)
- [x] Source fixes: `isAtCapacity()`, `loadMetrics`/`saveMetrics`, `buildModelProfile`, `markNodeUnreachable`, `mergeInventory`, `_isLocalhost`, `_determineNextScanInterval`, EMA metrics, `networkScanIntervalActive`, `getScanStatus.lastScanAgo`

## Phase 8 — Cleanup
- [ ] 8.1 Read + port `tests/pass-through-routes.test.ts`
- [ ] 8.2 Delete all `.js` source files, remove `allowJs: true`
- [ ] 8.3 `noImplicitAny: true`
- [ ] 8.4 `strictNullChecks: true`
- [ ] 8.5 `strict: true`

## Phase 9 — Polish
- [ ] 9.1 `src/types/OllamaApiTypes.ts`, `OpenAIApiTypes.ts`, `AnthropicApiTypes.ts`
- [ ] 9.2 README: document `typecheck`, TS dev setup
- [ ] 9.3 Dockerfile / Pi service verification with `tsx`

---

## Key exported types

| Type | File |
|---|---|
| `ModelProfile`, `ModelInfo`, `NodeInfo` | `models.ts` |
| `Config` | `config.ts` |
| `PersistedModelMetrics`, `loadMetrics`, `saveMetrics` | `metrics-store.ts` |
| `ScanResult` | `network-scanner.ts` |
| `LoadManagerConfig` | `load-manager.ts` |
| `RequestEntry`, `AttemptRecord` | `request-history.ts` |
| `AnalysisResult` | `request-analyzer.ts` |
| `DiscoveryConfig`, `ScanStatus` | `discovery-manager.ts` |
| `RoutingCandidate`, `VIRTUAL_MODELS` | `request-router.ts` |
| `AppConfig`, `AppResult` | `app.ts` |
| `RouteDeps`, `createRoutes` | `routes/index.ts` |
