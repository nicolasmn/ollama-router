# TypeScript Migration Plan

Incremental port of the codebase to TypeScript. Each commit in this PR ticks one checkbox below.

**Runtime**: `tsx` — no compile step, types stripped at runtime, fast Docker starts  
**Type-check**: `tsc --noEmit` — CI gate, never blocks runtime  
**Tests**: `ts-jest` (ESM mode) — `.test.js` renamed to `.test.ts` in Phase 7

JS files remain importable throughout via `allowJs: true` — tests stay green at every commit.

---

## Phase 0 — Tooling bootstrap

- [ ] **Commit 0.1** — add dev deps: `typescript`, `tsx`, `ts-jest`, `@types/node`, `@types/express`, `@types/ws`, `@types/pino`
- [ ] **Commit 0.2** — add `tsconfig.json`

  ```json
  {
    "compilerOptions": {
      "target": "ES2022",
      "module": "NodeNext",
      "moduleResolution": "NodeNext",
      "outDir": "dist",
      "rootDir": ".",
      "allowJs": true,
      "checkJs": false,
      "strict": false,
      "noImplicitAny": false,
      "skipLibCheck": true,
      "esModuleInterop": true,
      "declaration": true,
      "declarationMap": true,
      "sourceMap": true
    },
    "include": ["src/**/*", "index.ts", "tests/**/*"],
    "exclude": ["node_modules", "dist"]
  }
  ```

- [ ] **Commit 0.3** — update `package.json` scripts
  - `start`: `tsx index.ts`
  - `dev`: `tsx watch index.ts`
  - `typecheck`: `tsc --noEmit`
  - `test`: unchanged (Jest still targets `*.test.js` until Phase 7)
  - jest config: add `ts-jest` ESM transform, keep `testMatch: ["**/tests/**/*.test.js"]`

- [ ] **Commit 0.4** — update CI: add `npm run typecheck` step after install

---

## Phase 1 — Core types

> Leaf modules with no internal dependencies. Convert first so downstream files get real types immediately.

- [ ] **Commit 1.1** — `src/models.ts`
  - Convert `ModelProfile`, `ModelInfo`, `NodeInfo` classes
  - Export interfaces: `ModelProfileData`, `ModelInfoJSON`, `NodeInfoJSON`
  - All existing JS importers continue to work via `allowJs`

- [ ] **Commit 1.2** — `src/config.ts`
  - Export `Config` interface
  - Replace bare `process.env` accesses with typed accessors
  - `config.js` deleted

- [ ] **Commit 1.3** — `src/logger.ts`
  - Type `createLogger` return as `pino.Logger`
  - Export `LogContext` type
  - `logger.js` deleted

---

## Phase 2 — Utilities and storage

- [ ] **Commit 2.1** — `src/metrics-store.ts`
  - Export `PersistedNodeMetrics` and `PersistedModelMetrics` interfaces
  - Type `loadMetrics` return as `Map<string, Map<string, PersistedModelMetrics>>`
  - `metrics-store.js` deleted

- [ ] **Commit 2.2** — `src/network-scanner.ts`
  - Add `ScanResult` type, type `scanLocalNetwork(): Promise<string[]>`
  - `network-scanner.js` deleted

---

## Phase 3 — Managers

- [ ] **Commit 3.1** — `src/load-manager.ts`
  - Export `LoadManagerConfig` interface
  - Annotate `loads: Map<string, number>`
  - `load-manager.js` deleted

- [ ] **Commit 3.2** — `src/request-history.ts`
  - Export `RequestEntry`, `SelectionRecord`, `AttemptRecord`, `FinishRecord` interfaces
  - Type `RequestHistoryManager` fully
  - `request-history.js` deleted

- [ ] **Commit 3.3** — `src/request-analyzer.ts`
  - Export `AnalysisResult` interface (consumed by router + routes)
  - Type regex constants as `readonly RegExp[]`
  - `request-analyzer.js` deleted

---

## Phase 4 — Core routing

- [ ] **Commit 4.1** — `src/discovery-manager.ts`
  - Export `DiscoveryConfig` interface
  - Type `inventory: Map<string, NodeInfo>`
  - Type `buildModelProfile`, `probeNode`, `mergeInventory`
  - `discovery-manager.js` deleted

- [ ] **Commit 4.2** — `src/request-router.ts`
  - Export `RoutingCandidate` interface: `{ nodeHost: string; modelName: string; modelInfo: ModelInfo; score: number }`
  - Type `_scoreModel`, `_selectVirtual`, `_selectConcrete` return types
  - `request-router.js` deleted

- [ ] **Commit 4.3** — `src/ws-manager.ts`
  - Export `WsManagerConfig` interface
  - Type WebSocket event handlers
  - `ws-manager.js` deleted

---

## Phase 5 — Routes

- [ ] **Commit 5.1** — `src/routes/request-helpers.ts`
  Most critical shared module. Export:
  - `CandidateSelectionOptions`
  - `StreamingRequestOptions`
  - `RetryOptions`
  - `request-helpers.js` deleted

- [ ] **Commit 5.2** — `src/routes/models.ts` — `models.js` deleted
- [ ] **Commit 5.3** — `src/routes/admin.ts` — `admin.js` deleted
- [ ] **Commit 5.4** — `src/routes/embeddings.ts` — `embeddings.js` deleted
- [ ] **Commit 5.5** — `src/routes/chat.ts` — `chat.js` deleted
- [ ] **Commit 5.6** — `src/routes/responses.ts` — `responses.js` deleted
- [ ] **Commit 5.7** — `src/routes/messages.ts` — `messages.js` deleted
- [ ] **Commit 5.8** — `src/routes/ollama-inference.ts` — `ollama-inference.js` deleted
- [ ] **Commit 5.9** — `src/routes/ollama.ts` — `ollama.js` deleted
- [ ] **Commit 5.10** — `src/routes/index.ts` — `index.js` deleted

---

## Phase 6 — Entry point

- [ ] **Commit 6.1** — `src/app.ts` — Export `AppConfig` interface, type Express factory. `app.js` deleted.
- [ ] **Commit 6.2** — `index.ts` — Rename `index.js`. Wire typed config.
- [ ] **Commit 6.3** — `src/routes.js` (empty stub) deleted. Remove `allowJs: true` from `tsconfig.json`.

---

## Phase 7 — Tests

- [ ] **Commit 7.1** — rename all `tests/*.test.js` → `tests/*.test.ts`
- [ ] **Commit 7.2** — add types to test helpers, mocks, and `jest.fn()` generics
- [ ] **Commit 7.3** — update jest `testMatch` to `*.test.ts`, update CI

---

## Phase 8 — Strict mode (incremental)

- [ ] **Commit 8.1** — enable `noImplicitAny: true`, fix all implicit `any` errors
- [ ] **Commit 8.2** — enable `strictNullChecks: true`, fix null/undefined gaps
- [ ] **Commit 8.3** — enable `strict: true` (covers `strictFunctionTypes`, `strictBindCallApply`, `strictPropertyInitialization`, `noImplicitThis`, `alwaysStrict`)
- [ ] **Commit 8.4** — enable `noUncheckedIndexedAccess: true` for safe Map/array access

---

## Phase 9 — Polish

- [ ] **Commit 9.1** — add `src/types/` with shared API shapes: `OllamaApiTypes.ts`, `OpenAIApiTypes.ts`, `AnthropicApiTypes.ts` — replaces `any` casts in route handlers
- [ ] **Commit 9.2** — update README: document `npm run typecheck`, TS dev setup
- [ ] **Commit 9.3** — verify Dockerfile / Pi service scripts work with `tsx` runtime, update if needed

---

## Import convention

With `moduleResolution: NodeNext`, write import paths with `.js` extension even for `.ts` source files:

```ts
import { ModelInfo } from './models.js'  // TS resolves to models.ts, emits .js
```

This is standard Node ESM behaviour. Do not use `.ts` extensions in imports.

## Key types to export early (Phase 1–3)

These are consumed widely and should be typed first:

| Type | Exported from |
|---|---|
| `ModelProfile`, `ModelInfo`, `NodeInfo` | `src/models.ts` |
| `AnalysisResult` | `src/request-analyzer.ts` |
| `RoutingCandidate` | `src/request-router.ts` |
| `RequestEntry` | `src/request-history.ts` |
| `Config` | `src/config.ts` |
