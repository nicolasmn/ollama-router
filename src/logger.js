// logger.js - Single shared pino logger instance for the entire app
import pino from 'pino'

const LOG_LEVEL = process.env.LOG_LEVEL || 'info'
const isTTY = process.stdout.isTTY
const prettyRequested = process.env.LOG_FORMAT === 'pretty'
const jsonRequested = process.env.LOG_FORMAT === 'json'
const usePretty = prettyRequested || (isTTY && !jsonRequested)

let transport
if (usePretty) {
  transport = {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss.l',
      ignore: 'pid,hostname',
      messageFormat: '[{module}] {msg}',
      levelFirst: false,
    },
  }
}

const baseLogger = pino(
  {
    level: LOG_LEVEL,
    base: undefined, // removes pid + hostname from JSON output too
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  transport ? pino.transport(transport) : undefined,
)

/**
 * Create a child logger bound to a module name.
 * Every log line will carry { module } automatically.
 * @param {string} module - short module identifier, e.g. 'discovery', 'router'
 * @returns {import('pino').Logger}
 */
export function createLogger(module) {
  return baseLogger.child({ module })
}

export default baseLogger
