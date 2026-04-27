
# Ollama Router

Ollama Router is a lightweight OpenAI-compatible gateway in front of multiple Ollama nodes.

Instead of hardcoding one model endpoint, clients can call one router URL. The router discovers available models across nodes, understands request requirements, and forwards each request to the best currently available target.

## What This App Does

At its core, this service solves three problems:

1. Discovery and inventory
	It continuously probes configured Ollama nodes and builds a live inventory of which node hosts which model.

2. Capability-aware routing
	It inspects each request and derives requirements such as tools, vision, audio, embeddings, context size, and complexity. Models that cannot satisfy hard requirements are filtered out before scoring.

3. Load-aware failover
	It tracks concurrent request load per node, avoids over-capacity nodes, and retries non-streaming requests on alternative candidates if a chosen model fails.

## Key Routing Behavior

- Streaming chat requests: routed to one best candidate (no transparent mid-stream failover).
- Non-streaming chat/completions/embeddings: ranked candidates with retry fallback.
- Capacity guardrails: per-node concurrent request limits.
- Adaptive scoring: considers observed latency, throughput, context headroom, and model profile.

## API Endpoints

The router exposes OpenAI-style endpoints:

- POST /v1/chat/completions
- POST /v1/completions
- POST /v1/embeddings
- GET /v1/models
- GET /v1/models/{model}

Operational endpoints:

- GET /health
- GET /inventory
- GET /dashboard

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
- /v1/completions
- /v1/embeddings
- /v1/models and /v1/models/{model}

Not implemented in this router right now:

- /v1/responses
- /v1/images/generations
- OpenAI audio endpoints (e.g. /v1/audio/*)

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

- Discovery interval: 15000 ms
- Max concurrent requests per node: 3

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

## Raspberry Pi Service

The repository includes three helper scripts for Raspberry Pi OS with systemd:

- `scripts/install-rpi-service.sh`: first-time installation as a persistent service
- `scripts/update-rpi-service.sh`: deploy code updates without replacing your existing service configuration
- `scripts/uninstall-rpi-service.sh`: remove the systemd service, with optional full cleanup via `--purge`

Run the first install on the Pi from the repository root:

```bash
sudo ./scripts/install-rpi-service.sh
```

Run later updates on the Pi after pulling changes:

```bash
sudo ./scripts/update-rpi-service.sh
```

Remove the service from the Pi:

```bash
sudo ./scripts/uninstall-rpi-service.sh
```

Remove the service and also delete application files, metrics, configuration, and the service user:

```bash
sudo ./scripts/uninstall-rpi-service.sh --purge
```

Default service settings created by the installer:

- Install directory: `/opt/ollama-router`
- Persistent metrics: `/var/lib/ollama-router/model-metrics.json`
- Environment file: `/etc/ollama-router.env`
- Service name: `ollama-router`

The installer creates `/etc/ollama-router.env` only if it does not already exist. Adjust it after installation if your Ollama nodes are remote, for example:

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

## Example

Point an OpenAI-compatible client to the router:

- Base URL: http://localhost:8000/v1

Example chat request:

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
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
npm run lint
npm run lint:fix
npm run format
npm run format:check
```
