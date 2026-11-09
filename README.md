# Ollama Router

Ollama Router is a lightweight OpenAI-compatible gateway in front of multiple Ollama nodes.

Instead of hardcoding one model endpoint, clients can call one router URL. The router discovers available models across nodes, understands request requirements, and forwards each request to the best currently available target.

The proxy uses native OpenAI-compatible pass-through to Ollama `/v1` endpoints. It is intentionally thin at the API payload level and focuses on routing, failover, abort handling, and observability.

## What This App Does

At its core, this service solves three problems:

1. Discovery and inventory
	It continuously probes configured Ollama nodes and builds a live inventory of which node hosts which model.

2. Capability-aware routing
	It inspects each request and derives requirements such as tools, vision, audio, embeddings, context size, and complexity. Models that cannot satisfy hard requirements are filtered out before scoring.

3. Load-aware failover
	It tracks concurrent request load per node, avoids over-capacity nodes, and retries non-streaming requests on alternative candidates if a chosen model fails.

## Key Routing Behavior

- Streaming chat/responses requests: routed to one best candidate (no transparent mid-stream failover).
- Non-streaming chat/responses/embeddings: ranked candidates with retry fallback.
- Capacity guardrails: per-node concurrent request limits.
- Adaptive scoring: considers observed latency, throughput, context headroom, and model profile.

## API Endpoints

The router exposes OpenAI-style endpoints:

- POST /v1/chat/completions
- POST /v1/responses
- POST /v1/embeddings
- GET /v1/models
- GET /v1/models/{model}

Operational endpoints:

- GET /health
- GET /inventory
- GET /dashboard
- GET /dashboard/requests
- POST /discovery/scan-now

## Ollama OpenAI Compatibility (Minimal)

Based on https://docs.ollama.com/api/openai-compatibility:

- Ollama base URL for OpenAI SDKs: http://localhost:11434/v1/
- api_key is required by many OpenAI SDKs but ignored by Ollama (use any string, e.g. ollama)
- model is always required and must match a local Ollama model name (or alias)

Upstream Ollama currently documents support for:

- /v1/chat/completions (including vision content)
- /v1/completions
- /v1/embeddings
- /v1/models and /v1/models/{model}
- /v1/responses (non-stateful)
- /v1/images/generations (experimental)

This router currently implements:

- /v1/chat/completions
- /v1/responses (non-stateful)
- /v1/embeddings
- /v1/models and /v1/models/{model}

Not implemented in this router right now:

- /v1/completions
- /v1/images/generations
- OpenAI audio endpoints (e.g. /v1/audio/*)

Notes for `/v1/responses`:

- The proxy currently supports non-stateful usage.
- `previous_response_id` and `conversation` are rejected with `400`.

## Model Targeting

You can set the `model` field in requests to either a concrete model name or a router alias.

- `auto`: default router behavior — picks the best candidate across local and cloud nodes
- `auto-fast`: prefers small/fast models; includes cloud when no suitable local is available
- `auto-think`: routes only to thinking-capable models; includes cloud candidates
- `auto-local`: local-only variant — never routes to cloud nodes
- `<real-model-name>`: routes only to that model across discovered nodes

Notes:

- Unknown model names return `404` by default.
- Set `ROUTER_FALLBACK_TO_AUTO=true` to silently reroute unknown model names to `auto` selection instead of returning `404`. The `model` field in the response will reflect the actual model that served the request.
- Alias names are reserved and also listed in `/v1/models`.

Decision models (Ollama Jev-style, served via `POST /v1/systemone`) are listed like any other pulled model — `/v1/models` and `/api/tags` include them, matching Ollama. They answer typed questions/statements and return probabilities, not text. Chat requests that name a decision model explicitly are rejected with `MODEL_NOT_DECISION`; use `/v1/systemone` (or an explicit decision model name) for decision traffic.

## Force-Model Override

Force a specific model for the **next single request**, bypassing normal routing logic. The override is one-shot — consumed on the first routed request, then automatically cleared.

### From the dashboard

1. Open the dashboard and expand a node card.
2. Click the **▶** button on any model row to set that model as the override.
3. A yellow banner appears at the top of the dashboard: `Next request forced to <model>`.
4. Click **✕ Cancel** in the banner to clear the override before it is consumed.

The ▶ button is disabled on offline nodes. The banner updates in real time via the WebSocket connection.

### Via the admin API

```bash
# Set override (validates model exists on a reachable node)
curl -X POST http://localhost:8000/admin/force-model \
  -H 'Content-Type: application/json' \
  -d '{"model": "llama3.2"}'
# → { "ok": true, "model": "llama3.2", "expiresAt": 1234567890000 }

# Check current state
curl http://localhost:8000/admin/force-model
# → { "active": true, "model": "llama3.2", "expiresAt": ... }
# → { "active": false, "model": null, "expiresAt": null }

# Clear manually
curl -X DELETE http://localhost:8000/admin/force-model
# → { "ok": true, "cleared": true }
```

### Behaviour details

- **One-shot**: override consumed on first request routed after it is set.
- **TTL**: auto-expires after 10 minutes if not consumed.
- **Validation**: `POST` rejects model names not found on any reachable node (`404`).
- **Logging**: router logs `forcedModel: true` + original model name at `info` level when override applies.
- **Metrics**: resulting `RoutingCandidate` is tagged `forcedModel: true` for history/trace filtering.

## Configuration

Environment variables:

- `OLLAMA_NODES`: comma-separated node list. Example: `localhost:11434,10.0.0.12:11434`
- `OLLAMA_NODE_MEMORY_GB`: optional override for the memory (GB, i.e. GiB) that Ollama can use for loaded models on each node, as comma-separated `host=GB` pairs. Example: `192.168.1.20=64,mac-studio.local=21`. Use the memory Ollama can actually use, not the installed RAM — on Apple Silicon the GPU only gets part of unified memory by default (about 21 GB on a 32 GB Mac). Ollama logs this as `total` on its `inference compute` line at startup. Hosts match with or without scheme and port (`http://192.168.1.20:11434=64` restricts the entry to that port). Without an entry the router learns the value per node (see below); a configured value always wins. The cloud node is never penalized.
- `PORT`: router listen port (default: `8000`)
- `ROUTER_FALLBACK_TO_AUTO`: set to `true` to reroute requests for unknown model names to `auto` selection instead of returning `404` (default: `false`)

### Memory-aware co-location

Ollama keeps several models loaded and unloads idle ones when a new model does not fit (or when it would exceed its loaded-model limit), so routing a large *cold* model to a node can evict a hot one (the next request for it then pays a full reload). The router tracks this per non-cloud node:

- it polls `GET /api/ps` on every probe cycle to learn which models are loaded and their in-memory size (a failing `/api/ps` marks the loaded state unknown but never marks the node unreachable);
- it learns each model's real footprint from `/api/ps`; before a model has ever been seen loaded it estimates disk size × 1.3;
- when a request is dispatched, the model is counted as loaded on that node right away (estimated footprint, 5 min keep-alive) so a burst within one probe interval sees current free memory; the next probe replaces the snapshot;
- **memory** is `OLLAMA_NODE_MEMORY_GB` if configured, otherwise learned from consecutive `/api/ps` snapshots: when a model disappears before its expiry while a new one appears and the node held fewer models than its loaded-model limit, a total of that size did not fit; a partially GPU-offloaded model (`size_vram < size`) shows the GPU was full. The smallest "did not fit" total becomes the capacity, and it is forgotten again if a total that large is later seen loaded together;
- the **loaded-model limit** (`OLLAMA_MAX_LOADED_MODELS`, default 3 per GPU — the router cannot see the GPU count) is the value learned from an eviction that happened although that much had already fitted, else 3, raised to the most models ever seen loaded together on that node;
- both learned values are persisted in the metrics file and restored on startup.

A candidate gets an `eviction` factor (weight 20, `−1…0`): `0` when the model is already loaded or fits in `capacity − Σ loaded sizes` below the loaded-model limit, otherwise a penalty driven by the most recently used loaded model, since Ollama may unload any idle one — close to `−1` if it served traffic within 2 minutes, fading to `0` once every loaded model has been idle for 10 minutes, and `−1` when the model is larger than the whole node. It is a penalty, not a filter: a node can still win when it is much faster.

Caveats:

- The loaded-model limit applies to every non-cloud node with a known loaded state, so with no configuration at all routing is **not** identical to before: a cold model aimed at a node already holding 3 models is penalized. Memory predictions only start after one memory-triggered eviction has been observed on that node (or when `OLLAMA_NODE_MEMORY_GB` is set).
- Explicit unloads (`ollama stop`, `keep_alive: 0`) and normal expiry are ignored; they teach nothing.
- Loads that start and end between two probes are missed.

`GET /admin/inventory` shows per node `memoryBytes` (effective capacity) with `memorySource` (`config`, `learned` or `null`), the learned bounds `fitBytes` / `noFitBytes`, the effective `loadedLimit`, and `loaded` (models with `size`, `sizeVram`, `expiresAt`, and `updatedAt` of the snapshot); per model it shows `measuredFootprint` (bytes, `0` = never seen loaded).

### Request history privacy

Request history entries never store raw prompt text — only privacy-safe metadata: prompt length (`promptChars`), a short SHA-256 hash (`promptHash`), and message counts. Full message threads are held in a private store and served on demand via `GET /admin/requests/:id`; `GET /admin/requests` and WebSocket updates never carry content. That detail endpoint is gated on a per-process `dashboard_token` cookie set when the dashboard page is served, so only clients that loaded the dashboard can fetch thread content.

Current defaults in code:

- Health probe interval: 15000 ms
- Tags/model refresh interval: 60000 ms
- Max concurrent requests per node: 3
- Network scan interval (localhost-only mode): 60000 ms
- Network scan interval (network-node mode): 1800000 ms (30 min)

## Network Scan Strategy

Discovery is adaptive and uses three triggers:

1. Periodic background scan
	- If connected only to localhost nodes, scans every 60 seconds.
	- If connected to at least one non-localhost node, scans every 30 minutes.

2. On-request scan for virtual models (`auto`, `auto-fast`, `auto-think`, `auto-local`)
	- If the previous scan is fresh (< 5 minutes), scan runs async in background.
	- If scan data is stale (>= 5 minutes), router waits up to 3 seconds for a fresh scan, then falls back to current inventory.

3. Manual scan from dashboard
	- The Rescan button triggers an immediate scan via POST `/discovery/scan-now`.

Notes:

- Concurrent scans are prevented.
- Dashboard header shows scan recency (for example, `Scanned 4m ago`).

## Quick Start

Prerequisites:

- Node.js 18+
- npm

Install, build, and run:

```bash
npm install
npm run build
npm start
```

Development mode (clean build + watch for TypeScript, dashboard, and app changes):

```bash
npm run dev
```

## npm Scripts

| Script | Description |
|--------|-------------|
| `build` | Clean `dist/`, compile TypeScript, bundle and copy dashboard assets |
| `build:ts` | TypeScript-only compile step (`tsconfig.build.json`, no tests in output) |
| `build:dashboard` | Bundle dashboard JS and copy static assets to `dist/src/dashboard/` |
| `clean` | Remove `dist/` entirely |
| `start` | Run `dist/index.js` (requires prior build) |
| `dev` | Full build then parallel watch: TypeScript, dashboard bundle, and `tsx` app runner |
| `typecheck` | Type-check entire codebase including tests — no output emitted |
| `check` | `typecheck` + `lint` + `test` in one command |
| `test` | Run Jest test suite |
| `lint` | ESLint across `src/` and `index.ts` |
| `lint:fix` | ESLint with auto-fix |
| `format` | Prettier write |
| `format:check` | Prettier check |

## TypeScript

The codebase is fully TypeScript. Production is compiled via `tsc` (`tsconfig.build.json`) into `dist/`. Only `index.ts` and `src/**/*.ts` are emitted — tests are never part of the build output. Type-checking runs against the full project including tests:

```bash
npm run typecheck
```

Two TypeScript configs:

- `tsconfig.json` — full project typecheck (includes `tests/`); used by `typecheck` and IDEs
- `tsconfig.build.json` — production emit only (excludes `tests/`); used by `build` and `dev`

Shared API types live in `src/types/`: `OpenAIApiTypes.ts`, `OllamaApiTypes.ts`, `AnthropicApiTypes.ts`. Internal types (routing, config, models) are re-exported from `src/types/index.ts`.

## Raspberry Pi Service

`scripts/service.js` is a Linux-only systemd CLI for service registration and lifecycle management. Prerequisites: Linux with systemd, Node.js 18+, npm.

```bash
# register service (deploy + enable + start)
sudo node scripts/service.js register

# alias (backward compatibility)
sudo node scripts/service.js install

# service lifecycle
sudo node scripts/service.js start
sudo node scripts/service.js stop
sudo node scripts/service.js restart
sudo node scripts/service.js status

# deploy updates after pulling changes
sudo node scripts/service.js update

# remove the service (keeps files and configuration)
sudo node scripts/service.js uninstall

# remove everything including files, data, config, and service user
sudo node scripts/service.js uninstall --purge
```

You can also run through npm:

```bash
npm run service -- --help
npm run service -- status
```

The installer copies the application to `/opt/ollama-router`, installs production dependencies, creates a locked-down `ollama-router` system user, and registers a systemd unit. It creates `/etc/ollama-router.env` only if it does not already exist, so updates never overwrite your configuration.

Adjust `/etc/ollama-router.env` after the first install if your Ollama nodes are on other machines:

```bash
OLLAMA_NODES=192.168.1.50:11434,192.168.1.51:11434
AUTO_DISCOVER=false
```

Useful service commands:

```bash
systemctl status ollama-router
journalctl -u ollama-router -f
curl http://127.0.0.1:8000/health
```

`status` exit codes:

- `0`: service is active
- `1`: service is not active
- `2`: status check error

## Example

Point an OpenAI-compatible client to the router:

- Base URL: http://localhost:8000/v1

Example chat request:

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
	 "model": "auto",
	 "messages": [{"role": "user", "content": "Explain retrieval-augmented generation in simple terms."}],
	 "max_tokens": 300
  }'
```

## Observability

- Structured logs via pino
- Live node/model view at /dashboard
- Full machine-readable inventory at /inventory

## Development Commands

```bash
npm run typecheck   # tsc --noEmit, no emit — CI type gate
npm run lint
npm run lint:fix
npm run format
npm run format:check
```
