
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

- `auto`: default router behavior (best candidate)
- `auto-fast`: prefers small/fast models and falls back to `auto` if none match
- `auto-think`: strictly routes only to thinking-capable models
- `<real-model-name>`: routes only to that model across discovered nodes

Notes:

- Unknown model names return `404`.
- Alias names are reserved and also listed in `/v1/models`.

## Configuration

Environment variables:

- OLLAMA_NODES: comma-separated node list. Example: localhost:11434,10.0.0.12:11434
- PORT: router listen port (default: 8000)

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

2. On-request scan for virtual models (`auto`, `auto-fast`, `auto-think`)
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

Install and run:

```bash
npm install
npm start
```

Development mode:

```bash
npm run dev
```

## TypeScript

The codebase is fully TypeScript. Runtime uses `tsx` (no compile step — types stripped at runtime). Type-checking is a separate step:

```bash
npm run typecheck
```

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
