// index.ts - Application entry point
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
import { createLogger } from './src/logger.js'
import { cloudUsageStore } from './src/cloud-usage.js'

const logger = createLogger('index')

try {
  const { server, managers } = await createApp({
    ollamaNodes: OLLAMA_NODES,
    discoveryInterval: DISCOVERY_INTERVAL,
    maxConcurrentPerNode: MAX_CONCURRENT_PER_NODE,
    port: Number(PORT),
    autoDiscover: AUTO_DISCOVER,
    networkScanInterval: NETWORK_SCAN_INTERVAL,
    metricsFile: METRICS_FILE,
  })

  server.listen(PORT, () => {
    const url = `http://localhost:${PORT}`
    const isDev = process.env.NODE_ENV === 'development'

    if (isDev) {
      const nodes = OLLAMA_NODES.length > 0 ? OLLAMA_NODES.join(', ') : null
      console.log('')
      console.log('  \x1b[32m✓\x1b[0m  \x1b[1mollama-router\x1b[0m ready')
      console.log('')
      console.log(`  \x1b[2mDashboard:\x1b[0m  \x1b[36m\x1b[4m${url}\x1b[0m`)
      console.log(`  \x1b[2mAPI:\x1b[0m        \x1b[36m\x1b[4m${url}/v1\x1b[0m`)
      console.log('')
      if (nodes) {
        console.log(`  \x1b[2mNodes:\x1b[0m      ${nodes}`)
      } else {
        console.log(
          '  \x1b[2mDiscovery:\x1b[0m  auto — nodes appear as they come online',
        )
      }
      console.log('')
    } else {
      logger.info({ url }, `Router listening on ${url}`)
      logger.info(
        'Discovery running in background — nodes will appear as they come online',
      )
    }
  })

  let shuttingDown = false
  function shutdown(signal: string): void {
    if (shuttingDown) return
    shuttingDown = true
    logger.info(`${signal} received, shutting down gracefully`)
    cloudUsageStore.stop()
    managers.discovery.stopPeriodicProbe()
    managers.discovery.persistMetrics()
    managers.ws.stop()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
} catch (err) {
  logger.error({ error: (err as Error).message }, 'Failed to start application')
  process.exit(1)
}
