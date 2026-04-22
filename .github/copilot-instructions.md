---
name: 'ollama-router coding standards'
description: 'Enforce explicit type structures and content-driven analysis in the request routing system'
applyTo: ['src/**/*.js']
---

- Use **classes and typed properties** (not strings or mixed types)
- Detect needs from **actual content** (not prompt patterns)
- Parse **API responses directly** (not inferred from names)
- Keep **logic clean and separated** by concern, no backwards compatibility needed
- **Filter before scoring** to avoid wasteful computation
