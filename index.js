// index.js - Application entry point
import pino from 'pino'
import {
  OLLAMA_NODES,
  DISCOVERY_INTERVAL,
  MAX_CONCURRENT_PER_NODE,
  PORT,
} from './src/config.js'
import { createApp } from './src/app.js'

const logger = pino()

try {
  const { app, managers } = await createApp({
    ollamaNodes: OLLAMA_NODES,
    discoveryInterval: DISCOVERY_INTERVAL,
    maxConcurrentPerNode: MAX_CONCURRENT_PER_NODE,
    port: PORT,
  })

  // Start server
  app.listen(PORT, () => {
    logger.info(`Router listening on port ${PORT}`)
    logger.info(
      `Discovered ${managers.discovery.getReachableNodeCount()} reachable nodes`,
    )
  })

  // Handle graceful shutdown
  process.on('SIGTERM', () => {
    logger.info('SIGTERM received, shutting down gracefully')
    managers.discovery.stopPeriodicProbe()
    process.exit(0)
  })

  process.on('SIGINT', () => {
    logger.info('SIGINT received, shutting down gracefully')
    managers.discovery.stopPeriodicProbe()
    process.exit(0)
  })
} catch (err) {
  logger.error({ error: err.message }, 'Failed to start application')
  process.exit(1)
}
