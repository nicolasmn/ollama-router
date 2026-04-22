// config.js
import 'dotenv/config';

export const OLLAMA_NODES = (process.env.OLLAMA_NODES)?.split(',').filter(Boolean) ?? [];
export const DISCOVERY_INTERVAL = 15000;
export const MAX_CONCURRENT_PER_NODE = 3;
export const PORT = process.env.PORT || 8000;
// Auto-discover by default when no nodes are explicitly configured
export const AUTO_DISCOVER = process.env.AUTO_DISCOVER !== undefined
  ? process.env.AUTO_DISCOVER === 'true'
  : OLLAMA_NODES.length === 0;
export const NETWORK_SCAN_INTERVAL = Number.parseInt(process.env.NETWORK_SCAN_INTERVAL || '60000', 10);
