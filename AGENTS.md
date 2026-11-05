# Agent guidelines

- For all Ollama- and OpenAI-style routes, always do what the corresponding upstream API expects. Small improvements are acceptable only where they do not break existing expectations.
- Decision models (Jev-style, `supportsDecision`) are listed like any other pulled model; chat traffic that names one explicitly is rejected with `MODEL_NOT_DECISION` (400) — decisions go through `/v1/systemone`.
