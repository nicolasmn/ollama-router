# TypeScript Migration Plan

Incremental port of the codebase to TypeScript. Each commit in this PR ticks one checkbox below.

**Runtime**: `tsx` — no compile step, types stripped at runtime, fast Docker starts  
**Type-check**: `tsc --noEmit` — CI gate, never blocks runtime  
**Tests**: `ts-jest` (ESM mode) → renamed `.test.ts` in Phase 7

JS files remain importable throughout via `allowJs: true` — tests stay green at every commit.

---

## Phase 0 — Tooling bootstrap

- [x] **Commit 0.1** — add dev deps: `typescript`, `tsx`, `ts-jest`, `@types/node`, `@types/express`, `@types/ws`
- [x] **Commit 0.2** — add `tsconfig.json`
- [x] **Commit 0.3** — update `package.json` scripts (`start`/`dev` → `tsx`, add `typecheck`)
- [x] **Commit 0.4** — update CI: add `npm run typecheck` step after install

---

## Phase 1 — Core types

- [x] **Commit 1.1** — `src/models.ts` — `ModelProfile`, `ModelInfo`, `NodeInfo` + exported interfaces
- [x] **Commit 1.2** — `src/config.ts` — `Config` interface, typed env accessors
- [x] **Commit 1.3** — `src/logger.ts` — `LogModule`, `LogContext` types, typed `createLogger`

---

## Phase 2 — Utilities and storage

- [x] **Commit 2.1** — `src/metrics-store.ts` — `PersistedModelMetrics`, `PersistedMetrics` types
- [x] **Commit 2.2** — `src/network-scanner.ts` — `ScanResult` type, typed `scanLocalNetwork`

---

## Phase 3 — Managers

- [x] **Commit 3.1** — `src/load-manager.ts` — `LoadManagerConfig`, typed `loads: Map<string, number>`
- [x] **Commit 3.2** — `src/request-history.ts` — `RequestEntry`, `AttemptRecord`, `CandidateSummary`, `StartRequestOptions`, `FinishRequestOptions`
- [x] **Commit 3.3** — `src/request-analyzer.ts` — `AnalysisResult`, `EndpointType` exported

---

## Phase 4 — Core routing

- [ ] **Commit 4.1** — `src/discovery-manager.ts` — `DiscoveryConfig`, typed `inventory`
- [ ] **Commit 4.2** — `src/request-router.ts` — `RoutingCandidate`, typed scoring methods
- [ ] **Commit 4.3** — `src/ws-manager.ts` — `WsManagerConfig`, typed WebSocket handlers

---

## Phase 5 — Routes

- [ ] **Commit 5.1** — `src/routes/request-helpers.ts`
- [ ] **Commit 5.2** — `src/routes/models.ts`
- [ ] **Commit 5.3** — `src/routes/admin.ts`
- [ ] **Commit 5.4** — `src/routes/embeddings.ts`
- [ ] **Commit 5.5** — `src/routes/chat.ts`
- [ ] **Commit 5.6** — `src/routes/responses.ts`
- [ ] **Commit 5.7** — `src/routes/messages.ts`
- [ ] **Commit 5.8** — `src/routes/ollama-inference.ts`
- [ ] **Commit 5.9** — `src/routes/ollama.ts`
- [ ] **Commit 5.10** — `src/routes/index.ts`

---

## Phase 6 — Entry point

- [ ] **Commit 6.1** — `src/app.ts`
- [ ] **Commit 6.2** — `index.ts`
- [ ] **Commit 6.3** — delete all `.js` source files, remove `allowJs: true`

---

## Phase 7 — Tests

- [ ] **Commit 7.1** — rename `tests/*.test.js` → `tests/*.test.ts`
- [ ] **Commit 7.2** — add generics to mocks and helpers
- [ ] **Commit 7.3** — update `testMatch` to `*.test.ts`, update CI

---

## Phase 8 — Strict mode

- [ ] **Commit 8.1** — `noImplicitAny: true`
- [ ] **Commit 8.2** — `strictNullChecks: true`
- [ ] **Commit 8.3** — `strict: true`
- [ ] **Commit 8.4** — `noUncheckedIndexedAccess: true`

---

## Phase 9 — Polish

- [ ] **Commit 9.1** — `src/types/` with `OllamaApiTypes.ts`, `OpenAIApiTypes.ts`, `AnthropicApiTypes.ts`
- [ ] **Commit 9.2** — README: document `typecheck`, TS dev setup
- [ ] **Commit 9.3** — Dockerfile / Pi service script verification with `tsx`

---

## Import convention

With `moduleResolution: NodeNext`, write import paths with `.js` extension even for `.ts` source files:

```ts
import { ModelInfo } from './models.js'  // TS resolves to models.ts, emits .js
```

## Key types (Phases 1–3, all done)

| Type | Exported from |
|---|---|
| `ModelProfile`, `ModelInfo`, `NodeInfo` | `src/models.ts` |
| `Config` | `src/config.ts` |
| `Logger`, `LogContext` | `src/logger.ts` |
| `PersistedModelMetrics` | `src/metrics-store.ts` |
| `ScanResult` | `src/network-scanner.ts` |
| `LoadManagerConfig` | `src/load-manager.ts` |
| `RequestEntry`, `AttemptRecord`, `FinishRequestOptions` | `src/request-history.ts` |
| `AnalysisResult`, `EndpointType` | `src/request-analyzer.ts` |
| `RoutingCandidate` _(Phase 4.2)_ | `src/request-router.ts` |
| `DiscoveryConfig` _(Phase 4.1)_ | `src/discovery-manager.ts` |
