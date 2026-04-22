// config.js
import 'dotenv/config';

export const OLLAMA_NODES = (process.env.OLLAMA_NODES)?.split(',') ?? [];
export const DISCOVERY_INTERVAL = 15000;
export const MAX_CONCURRENT_PER_NODE = 3;
export const PORT = process.env.PORT || 8000;