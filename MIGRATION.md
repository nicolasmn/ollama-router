# TypeScript Migration Plan

Incremental port of the codebase to TypeScript. Each commit in this PR ticks one checkbox below.

**Runtime**: `tsx` — no compile step, types stripped at runtime, fast Docker starts  
**Type-check**: `tsc --noEmit` — CI gate, never blocks runtime  
**Tests**: `ts-jest` (ESM mode) → renamed `.test.ts` in Phase 7

JS files remain importable throughout via `allowJs: true` — tests stay green at every commit.

---

## Phase 0 — Tooling bootstrap ✅
- [x] 0.1–0.4 done

## Phase 1 — Core types ✅
- [x] 1.1 `src/models.ts`
- [x] 1.2 `src/config.ts`
- [x] 1.3 `src/logger.ts`

## Phase 2 — Utilities ✅
- [x] 2.1 `src/metrics-store.ts`
- [x] 2.2 `src/network-scanner.ts`

## Phase 3 — Managers ✅
- [x] 3.1 `src/load-manager.ts` — `LoadManagerConfig` with `onNodeLoadChange`, `cleanupOrphanedNodes`
- [x] 3.2 `src/request-history.ts`
- [x] 3.3 `src/request-analyzer.ts`

## Phase 4 — Core routing ✅
- [x] 4.1 `src/discovery-manager.ts` — `DiscoveryConfig`, `ScanStatus`, `setInventoryUpdateHandler`
- [x] 4.2 `src/request-router.ts` — `RoutingCandidate`, `ModelCatalogEntry`, `VIRTUAL_MODELS` (Set)
- [x] 4.3 `src/ws-manager.ts` — `WsManagerConfig`

## Phase 5 — Routes ✅
- [x] 5.1 `src/routes/request-helpers.ts`
- [x] 5.2–10 all route files

## Phase 6 — Entry point ✅
- [x] 6.1 `src/app.ts` — `AppConfig`, `AppManagers`, `AppResult`
- [x] 6.2 `index.ts`
- [x] 6.3 `src/routes/index.ts` — added `createRoutes` flat-param adapter matching JS signature
- [ ] 6.4 delete all `.js` source files, remove `allowJs: true` (after Phase 7 tests pass)

## Phase 7 — Tests
- [ ] 7.1 rename `tests/*.test.js` → `tests/*.test.ts`
- [ ] 7.2 add generics to mocks
- [ ] 7.3 update `testMatch`, CI

## Phase 8 — Strict mode
- [ ] 8.1 `noImplicitAny: true`
- [ ] 8.2 `strictNullChecks: true`
- [ ] 8.3 `strict: true`
- [ ] 8.4 `noUncheckedIndexedAccess: true`

## Phase 9 — Polish
- [ ] 9.1 `src/types/OllamaApiTypes.ts`, `OpenAIApiTypes.ts`, `AnthropicApiTypes.ts`
- [ ] 9.2 README: document `typecheck`, TS dev setup
- [ ] 9.3 Dockerfile / Pi service script verification with `tsx`

---

## Import convention

```ts
import { ModelInfo } from './models.js'  // .js extension — NodeNext resolves to .ts
```

## Key exported types

| Type | File |
|---|---|
| `ModelProfile`, `ModelInfo`, `NodeInfo` | `models.ts` |
| `Config` | `config.ts` |
| `Logger`, `LogContext` | `logger.ts` |
| `PersistedModelMetrics` | `metrics-store.ts` |
| `ScanResult` | `network-scanner.ts` |
| `LoadManagerConfig` | `load-manager.ts` |
| `RequestEntry`, `AttemptRecord` | `request-history.ts` |
| `AnalysisResult`, `EndpointType` | `request-analyzer.ts` |
| `DiscoveryConfig`, `ScanStatus` | `discovery-manager.ts` |
| `RoutingCandidate`, `RouterError`, `VIRTUAL_MODELS` | `request-router.ts` |
| `WsManagerConfig` | `ws-manager.ts` |
| `StreamingRequestOptions`, `TryCandidatesOptions` | `routes/request-helpers.ts` |
| `RouteDeps`, `createRoutes` | `routes/index.ts` |
| `AppConfig`, `AppResult` | `app.ts` |
