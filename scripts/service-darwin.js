#!/usr/bin/env node
// scripts/service-darwin.js — macOS launchd service CLI
// Usage: sudo node scripts/service.js <register|start|stop|restart|status|update|uninstall>

import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  rmSync,
  existsSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { cac } from 'cac'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SOURCE_DIR = resolve(__dirname, '..')

const APP_NAME = 'ollama-router'
const SERVICE_LABEL = 'com.ollama-router'
const INSTALL_DIR = '/opt/ollama-router'
const DATA_DIR = '/var/lib/ollama-router'
const ENV_FILE = '/etc/ollama-router.env'
const LOG_DIR = '/var/log/ollama-router'
const PLIST_FILE = `/Library/LaunchDaemons/${SERVICE_LABEL}.plist`

const STATUS_EXIT_RUNNING = 0
const STATUS_EXIT_STOPPED = 1
const STATUS_EXIT_ERROR = 2

const APP_VERSION = readVersion()

function readVersion() {
  try {
    return JSON.parse(readFileSync(join(SOURCE_DIR, 'package.json'), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

// ---------------------------------------------------------------------------
// Plist and env builders
// ---------------------------------------------------------------------------

function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return {}
  return Object.fromEntries(
    readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const idx = l.indexOf('=')
        return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()]
      }),
  )
}

function buildEnvDict(envObj) {
  return Object.entries(envObj)
    .map(([k, v]) => `\t\t<key>${k}</key>\n\t\t<string>${v}</string>`)
    .join('\n')
}

function buildPlist() {
  const env = parseEnvFile(ENV_FILE)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${SERVICE_LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>node</string>
\t\t<string>${INSTALL_DIR}/dist/index.js</string>
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
${buildEnvDict(env)}
\t</dict>
\t<key>WorkingDirectory</key>
\t<string>${INSTALL_DIR}</string>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>StandardOutPath</key>
\t<string>${LOG_DIR}/stdout.log</string>
\t<key>StandardErrorPath</key>
\t<string>${LOG_DIR}/stderr.log</string>
</dict>
</plist>`
}

function buildDefaultEnv() {
  return `PORT=8000
OLLAMA_NODES=127.0.0.1:11434
AUTO_DISCOVER=false
NETWORK_SCAN_INTERVAL=300000
METRICS_FILE=${DATA_DIR}/model-metrics.json
INFERENCE_TIMEOUT=0
`
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd, args = []) {
  execFileSync(cmd, args, { stdio: 'inherit' })
}

function runCapture(cmd, args = []) {
  return execFileSync(cmd, args, { encoding: 'utf8' }).trim()
}

function assertRoot() {
  if (process.getuid?.() !== 0) {
    console.error('This command must be run with sudo or as root.')
    process.exit(1)
  }
}

function assertDarwin() {
  if (process.platform !== 'darwin') {
    console.error('This file is for macOS only.')
    process.exit(1)
  }
}

function assertRegistered() {
  if (!existsSync(PLIST_FILE)) {
    console.error(`Service not registered: ${PLIST_FILE}`)
    console.error('Run: sudo npm run service -- register')
    process.exit(1)
  }
}

function assertSourceDir() {
  if (
    !existsSync(join(SOURCE_DIR, 'package.json')) ||
    !existsSync(join(SOURCE_DIR, 'index.ts'))
  ) {
    console.error(
      `Could not find a valid ollama-router source directory: ${SOURCE_DIR}`,
    )
    process.exit(1)
  }
}

function isServiceLoaded() {
  try {
    runCapture('launchctl', ['print', `system/${SERVICE_LABEL}`])
    return true
  } catch {
    return false
  }
}

function assertCommandAvailable(name) {
  try {
    runCapture('which', [name])
  } catch {
    console.error(`${name} was not found in PATH.`)
    process.exit(1)
  }
}

// Deploy source files and install production dependencies
// Mirrors the Linux flow: build dist/ in the source checkout, then sync only
// the compiled output plus static dashboard assets into the install directory.
function deployFiles() {
  assertCommandAvailable('rsync')

  // 1. Build in source dir — devDependencies (tsc) are required here
  console.log('Installing dependencies...')
  run('npm', ['install', '--prefix', SOURCE_DIR])
  console.log('Building TypeScript...')
  run('npm', ['run', 'build', '--prefix', SOURCE_DIR])

  // 2. Prepare install directories
  mkdirSync(`${INSTALL_DIR}/dist/src`, { recursive: true })
  mkdirSync(DATA_DIR, { recursive: true })
  mkdirSync(LOG_DIR, { recursive: true })

  // 3. Sync compiled JS output (tsc + esbuild write to dist/)
  run('rsync', ['-a', '--delete', `${SOURCE_DIR}/dist/`, `${INSTALL_DIR}/dist/`])

  // 4. Sync dashboard static assets (HTML/CSS — not compiled by tsc/esbuild).
  //    The JS bundle is already in dist/ from the build step above.
  run('rsync', [
    '-a',
    '--delete',
    '--exclude=*.js',
    `${SOURCE_DIR}/src/dashboard/`,
    `${INSTALL_DIR}/dist/src/dashboard/`,
  ])

  // 5. Install production-only dependencies
  run('cp', [`${SOURCE_DIR}/package.json`, `${INSTALL_DIR}/package.json`])
  run('cp', [`${SOURCE_DIR}/package-lock.json`, `${INSTALL_DIR}/package-lock.json`])
  run('npm', ['ci', '--omit=dev', '--prefix', INSTALL_DIR])
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function register() {
  assertDarwin()
  assertRoot()
  assertSourceDir()

  deployFiles()

  if (!existsSync(ENV_FILE)) {
    writeFileSync(ENV_FILE, buildDefaultEnv(), { mode: 0o640 })
  }

  writeFileSync(PLIST_FILE, buildPlist())
  run('launchctl', ['bootstrap', 'system', PLIST_FILE])

  console.log('\nRegistration complete.')
  console.log(`Logs:          tail -f ${LOG_DIR}/stdout.log`)
  console.log(`Health:        curl http://127.0.0.1:8000/health`)
  console.log(`Configuration: ${ENV_FILE}`)
}

function update() {
  assertDarwin()
  assertRoot()
  assertSourceDir()
  assertRegistered()

  if (isServiceLoaded()) {
    try { run('launchctl', ['bootout', 'system', PLIST_FILE]) } catch { /* best-effort */ }
  }

  deployFiles()

  writeFileSync(PLIST_FILE, buildPlist())
  run('launchctl', ['bootstrap', 'system', PLIST_FILE])

  console.log('\nUpdate complete.')
  console.log(`Logs:   tail -f ${LOG_DIR}/stdout.log`)
  console.log(`Health: curl http://127.0.0.1:8000/health`)
}

function start() {
  assertDarwin()
  assertRoot()
  assertRegistered()
  run('launchctl', ['kickstart', '-k', `system/${SERVICE_LABEL}`])
  console.log(`Service started: ${APP_NAME}`)
}

function stop() {
  assertDarwin()
  assertRoot()
  assertRegistered()
  run('launchctl', ['kill', 'SIGTERM', `system/${SERVICE_LABEL}`])
  console.log(`Service stopped: ${APP_NAME}`)
}

function restart() {
  assertDarwin()
  assertRoot()
  assertRegistered()
  run('launchctl', ['kickstart', '-k', `system/${SERVICE_LABEL}`])
  console.log(`Service restarted: ${APP_NAME}`)
}

function status() {
  assertDarwin()

  try {
    const out = runCapture('launchctl', ['print', `system/${SERVICE_LABEL}`])
    const running = out.includes('state = running')

    console.log(`Service: ${SERVICE_LABEL}`)
    console.log(`Active:  ${running ? 'running' : 'stopped'}`)
    console.log(out)

    process.exit(running ? STATUS_EXIT_RUNNING : STATUS_EXIT_STOPPED)
  } catch {
    console.log(`Service not loaded: ${SERVICE_LABEL}`)
    process.exit(STATUS_EXIT_ERROR)
  }
}

function uninstall({ purge = false } = {}) {
  assertDarwin()
  assertRoot()

  if (isServiceLoaded()) {
    try { run('launchctl', ['bootout', 'system', PLIST_FILE]) } catch { /* best-effort */ }
  }

  if (existsSync(PLIST_FILE)) unlinkSync(PLIST_FILE)

  if (purge) {
    if (existsSync(INSTALL_DIR)) rmSync(INSTALL_DIR, { recursive: true, force: true })
    if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true })
    if (existsSync(LOG_DIR)) rmSync(LOG_DIR, { recursive: true, force: true })
    if (existsSync(ENV_FILE)) unlinkSync(ENV_FILE)

    console.log('\nUninstall complete. Service, files, data, and configuration removed.')
  } else {
    console.log('\nUninstall complete. Service registration removed.')
    console.log(`Application files kept: ${INSTALL_DIR}`)
    console.log(`Data kept:              ${DATA_DIR}`)
    console.log(`Configuration kept:     ${ENV_FILE}`)
    console.log('Run with --purge to remove everything.')
  }
}

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

const cli = cac('ollama-router')

cli.version(APP_VERSION, '-v, --version')
cli.help()

cli.command('register', 'register and start the launchd daemon').action(() => register())
cli.command('install', 'alias for register').action(() => register())
cli.command('start', 'start the launchd service').action(() => start())
cli.command('stop', 'stop the launchd service').action(() => stop())
cli.command('restart', 'restart the launchd service').action(() => restart())
cli.command('status', 'show launchd service status').action(() => status())
cli.command('update', 'deploy updates and restart service').action(() => update())
cli
  .command('uninstall', 'remove launchd service registration')
  .option('--purge', 'also remove files, data, and config')
  .action((options) => uninstall({ purge: Boolean(options.purge) }))

try {
  cli.parse()
} catch (err) {
  console.error(err?.message || String(err))
  process.exit(1)
}
