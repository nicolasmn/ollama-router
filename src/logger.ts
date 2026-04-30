// logger.ts - Single shared pino logger instance for the entire app
import pino, { type Logger } from 'pino'

export type { Logger }

/** Short module identifier carried on every log line, e.g. 'discovery', 'router'. */
export type LogModule =
  | 'discovery'
  | 'router'
  | 'request'
  | 'chat'
  | 'responses'
  | 'messages'
  | 'embeddings'
  | 'ollama'
  | 'admin'
  | 'app'
  | 'ws'
  | string

/** Additional context fields that may be attached to a log entry. */
export interface LogContext {
  module?: LogModule
  nodeHost?: string
  modelName?: string
  requestId?: string
  endpoint?: string
  latency?: number
  err?: unknown
  [key: string]: unknown
}

const isTest = process.env.NODE_ENV === 'test'
const LOG_LEVEL = isTest ? 'silent' : (process.env.LOG_LEVEL || 'info')
const isTTY = process.stdout.isTTY
const prettyRequested = process.env.LOG_FORMAT === 'pretty'
const jsonRequested = process.env.LOG_FORMAT === 'json'
const usePretty = !isTest && (prettyRequested || (isTTY && !jsonRequested))

let transport: pino.TransportSingleOptions | undefined
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

const baseLogger: Logger = pino(
  {
    level: LOG_LEVEL,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  transport ? pino.transport(transport) : undefined,
)

/**
 * Create a child logger bound to a module name.
 * Every log line will carry { module } automatically.
 */
export function createLogger(module: LogModule): Logger {
  return baseLogger.child({ module })
}

export default baseLogger
