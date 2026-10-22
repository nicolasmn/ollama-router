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

  // How long systemd will allow graceful drain before SIGKILL (unit file sets
  // TimeoutStopSec to the same value). Node quits slightly before the deadline
  // so the timer itself finishes the job cleanly.
  const DRAIN_TIMEOUT_MS = 14 * 60 * 1000

  // In-flight work = max of node-side routing claims and history-side active
  // entries, so a request stuck in either layer still blocks shutdown.
  function activeWorkCount(): number {
    let nodeLoad = 0
    for (const host of managers.discovery.getNodes().keys()) {
      nodeLoad += managers.load.getCurrentLoad(host)
    }
    return Math.max(nodeLoad, managers.requests.activeRequestCount())
  }

  let shuttingDown = false
  function shutdown(signal: string): void {
    if (shuttingDown) {
      // Second signal (manual double-kill, or a fast systemctl stop/restart
      // pair) — don't wait for the drain, stop immediately.
      logger.warn(`${signal} received again — forcing immediate exit`)
      process.exit(0)
      return
    }
    shuttingDown = true
    logger.info(
      `${signal} received — draining, waiting for in-flight requests to finish (send ${signal} again to stop immediately)`,
    )
    cloudUsageStore.stop()
    managers.discovery.stopPeriodicProbe()
    managers.discovery.persistMetrics()
    managers.ws.stop()
    // Stop accepting new connections immediately; existing inference
    // requests keep running until they complete (or the drain dead-
    // line is hit).
    server.close()

    const deadline = Date.now() + DRAIN_TIMEOUT_MS
    let lastProgressLog = 0
    const drainPoll = setInterval(() => {
      const active = activeWorkCount()
      if (active === 0) {
        clearInterval(drainPoll)
        managers.discovery.persistMetrics()
        logger.info('Drained — all requests finished, exiting')
        process.exit(0)
        return
      }
      if (Date.now() >= deadline) {
        clearInterval(drainPoll)
        logger.warn(
          `Drain deadline reached with ${active} request(s) still in flight — exiting`,
        )
        process.exit(0)
        return
      }
      if (Date.now() - lastProgressLog > 15_000) {
        lastProgressLog = Date.now()
        logger.info(`Draining — ${active} request(s) still in flight`)
      }
    }, 250)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
} catch (err) {
  logger.error({ error: (err as Error).message }, 'Failed to start application')
  process.exit(1)
}
