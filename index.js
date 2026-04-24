// index.js - Application entry point
import pino from 'pino'
import {
  OLLAMA_NODES,
  DISCOVERY_INTERVAL,
  MAX_CONCURRENT_PER_NODE,
  PORT,
  AUTO_DISCOVER,
  NETWORK_SCAN_INTERVAL,
  METRICS_FILE,
} from './src/config.js'
import { createApp } from './src/app.js'

const logger = pino()

try {
  const { server, managers } = await createApp({
    ollamaNodes: OLLAMA_NODES,
    discoveryInterval: DISCOVERY_INTERVAL,
    maxConcurrentPerNode: MAX_CONCURRENT_PER_NODE,
    port: PORT,
    autoDiscover: AUTO_DISCOVER,
    networkScanInterval: NETWORK_SCAN_INTERVAL,
    metricsFile: METRICS_FILE,
  })

  // Start server
  server.listen(PORT, () => {
    logger.info(`Router listening on port ${PORT}`)
    logger.info(
      `Discovered ${managers.discovery.getReachableNodeCount()} reachable nodes`,
    )
  })

  let shuttingDown = false
  function shutdown(signal) {
    if (shuttingDown) return
    shuttingDown = true
    logger.info(`${signal} received, shutting down gracefully`)
    managers.discovery.stopPeriodicProbe()
    managers.ws.stop()
    server.close(() => process.exit(0))
    // Force exit if connections don't drain within 3 seconds
    setTimeout(() => process.exit(0), 3000).unref()
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
} catch (err) {
  logger.error({ error: err.message }, 'Failed to start application')
  process.exit(1)
}
