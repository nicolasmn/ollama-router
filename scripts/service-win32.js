#!/usr/bin/env node
// scripts/service-win32.js — Windows service CLI (via node-windows)
// Usage: node scripts/service.js <register|start|stop|restart|status|update|uninstall>
// Requires an elevated (Administrator) shell.

import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  rmSync,
  existsSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { cac } from 'cac'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const SOURCE_DIR = resolve(__dirname, '..')

const APP_NAME = 'ollama-router'
const INSTALL_DIR = 'C:\\ProgramData\\ollama-router'
const DATA_DIR = join(INSTALL_DIR, 'data')
const ENV_FILE = join(INSTALL_DIR, 'ollama-router.env')
const LOG_DIR = join(INSTALL_DIR, 'logs')

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
// Helpers
// ---------------------------------------------------------------------------

function loadNodeWindows() {
  try {
    return require('node-windows')
  } catch {
    console.error('node-windows is not installed.')
    console.error('Run: npm install node-windows')
    process.exit(1)
  }
}

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

function buildDefaultEnv() {
  return `PORT=8000\r\nOLLAMA_NODES=127.0.0.1:11434\r\nAUTO_DISCOVER=false\r\nNETWORK_SCAN_INTERVAL=300000\r\nMETRICS_FILE=${DATA_DIR}\\model-metrics.json\r\nINFERENCE_TIMEOUT=0\r\n`
}

function runCapture(cmd, args = []) {
  return execFileSync(cmd, args, { encoding: 'utf8' }).trim()
}

function assertWin32() {
  if (process.platform !== 'win32') {
    console.error('This file is for Windows only.')
    process.exit(1)
  }
}

function assertRegistered() {
  try {
    runCapture('sc', ['query', APP_NAME])
  } catch {
    console.error(`Service not registered: ${APP_NAME}`)
    console.error('Run: node scripts/service.js register  (as Administrator)')
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

function createService() {
  const { Service } = loadNodeWindows()
  const env = parseEnvFile(ENV_FILE)
  return new Service({
    name: APP_NAME,
    description: 'Ollama load-balancing router',
    script: join(INSTALL_DIR, 'dist', 'index.js'),
    workingDirectory: INSTALL_DIR,
    logpath: LOG_DIR,
    env: Object.entries(env).map(([name, value]) => ({ name, value })),
  })
}

// node.exe refuses to spawn .cmd shims directly (Node 20+ hardening), so run
// npm through its CLI entry point with the current node binary.
function runNpm(args) {
  const npmCli = join(
    process.execPath,
    '..',
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  )
  execFileSync(process.execPath, [npmCli, ...args], { stdio: 'inherit' })
}

// robocopy uses exit codes 0-7 for success-only states (1 = files copied);
// anything at 8 or above is a real failure.
function runRobocopy(args) {
  try {
    execFileSync('robocopy', args, { stdio: 'inherit' })
  } catch (err) {
    if (typeof err?.status === 'number' && err.status < 8) return
    throw err
  }
}

// Deploy source files and install production dependencies
// Mirrors the Linux flow: build dist/ in the source checkout, then sync only
// the compiled output plus static dashboard assets into the install directory.
function deployFiles() {
  // 1. Build in source dir — devDependencies (tsc) are required here
  console.log('Installing dependencies...')
  runNpm(['install', '--prefix', SOURCE_DIR])
  console.log('Building TypeScript...')
  runNpm(['run', 'build', '--prefix', SOURCE_DIR])

  // 2. Prepare install directories
  mkdirSync(join(INSTALL_DIR, 'dist', 'src'), { recursive: true })
  mkdirSync(DATA_DIR, { recursive: true })
  mkdirSync(LOG_DIR, { recursive: true })

  // 3. Sync compiled JS output (tsc + esbuild write to dist/).
  //    /MIR prunes stale files the same way rsync --delete does.
  runRobocopy([`${SOURCE_DIR}\\dist`, `${INSTALL_DIR}\\dist`, '/MIR', '/NJH', '/NJP'])

  // 4. Sync dashboard static assets (HTML/CSS — not compiled by tsc/esbuild).
  //    The JS bundle is already in dist/ from the build step above.
  runRobocopy([
    `${SOURCE_DIR}\\src\\dashboard`,
    `${INSTALL_DIR}\\dist\\src\\dashboard`,
    '/MIR', '/XF', '*.js', '/NJH', '/NJP',
  ])

  // 5. Install production-only dependencies
  copyFileSync(join(SOURCE_DIR, 'package.json'), join(INSTALL_DIR, 'package.json'))
  copyFileSync(
    join(SOURCE_DIR, 'package-lock.json'),
    join(INSTALL_DIR, 'package-lock.json'),
  )
  runNpm(['ci', '--omit=dev', '--prefix', INSTALL_DIR])
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function register() {
  assertWin32()
  assertSourceDir()
  deployFiles()

  if (!existsSync(ENV_FILE)) {
    writeFileSync(ENV_FILE, buildDefaultEnv())
  }

  const svc = createService()
  svc.on('install', () => {
    svc.start()
    console.log('\nRegistration complete.')
    console.log(`Logs:          ${LOG_DIR}`)
    console.log(`Health:        curl http://127.0.0.1:8000/health`)
    console.log(`Configuration: ${ENV_FILE}`)
  })
  svc.on('error', (err) => { console.error(err); process.exit(1) })
  svc.install()
}

function update() {
  assertWin32()
  assertSourceDir()
  assertRegistered()

  const svc = createService()
  svc.on('stop', () => {
    deployFiles()
    const fresh = createService()
    fresh.on('start', () => {
      console.log('\nUpdate complete.')
      console.log(`Logs:   ${LOG_DIR}`)
      console.log(`Health: curl http://127.0.0.1:8000/health`)
    })
    fresh.start()
  })
  svc.stop()
}

function start() {
  assertWin32()
  assertRegistered()
  const svc = createService()
  svc.on('start', () => console.log(`Service started: ${APP_NAME}`))
  svc.start()
}

function stop() {
  assertWin32()
  assertRegistered()
  const svc = createService()
  svc.on('stop', () => console.log(`Service stopped: ${APP_NAME}`))
  svc.stop()
}

function restart() {
  assertWin32()
  assertRegistered()
  const svc = createService()
  svc.on('stop', () => {
    const fresh = createService()
    fresh.on('start', () => console.log(`Service restarted: ${APP_NAME}`))
    fresh.start()
  })
  svc.stop()
}

function status() {
  assertWin32()
  try {
    const out = runCapture('sc', ['query', APP_NAME])
    const running = out.includes('RUNNING')

    console.log(`Service: ${APP_NAME}`)
    console.log(`Active:  ${running ? 'running' : 'stopped'}`)
    console.log(out)

    process.exit(running ? STATUS_EXIT_RUNNING : STATUS_EXIT_STOPPED)
  } catch {
    console.log(`Service not found: ${APP_NAME}`)
    process.exit(STATUS_EXIT_ERROR)
  }
}

function uninstall({ purge = false } = {}) {
  assertWin32()

  const svc = createService()
  svc.on('uninstall', () => {
    if (purge) {
      if (existsSync(INSTALL_DIR)) rmSync(INSTALL_DIR, { recursive: true, force: true })
      console.log('\nUninstall complete. Service, files, data, and configuration removed.')
    } else {
      console.log('\nUninstall complete. Service registration removed.')
      console.log(`Application files kept: ${INSTALL_DIR}`)
      console.log(`Data kept:              ${DATA_DIR}`)
      console.log(`Configuration kept:     ${ENV_FILE}`)
      console.log('Run with --purge to remove everything.')
    }
  })
  svc.on('error', (err) => { console.error(err); process.exit(1) })
  svc.uninstall()
}

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

const cli = cac('ollama-router')

cli.version(APP_VERSION, '-v, --version')
cli.help()

cli.command('register', 'register and start the Windows service').action(() => register())
cli.command('install', 'alias for register').action(() => register())
cli.command('start', 'start the Windows service').action(() => start())
cli.command('stop', 'stop the Windows service').action(() => stop())
cli.command('restart', 'restart the Windows service').action(() => restart())
cli.command('status', 'show Windows service status').action(() => status())
cli.command('update', 'deploy updates and restart service').action(() => update())
cli
  .command('uninstall', 'remove Windows service registration')
  .option('--purge', 'also remove files, data, and config')
  .action((options) => uninstall({ purge: Boolean(options.purge) }))

try {
  cli.parse()
} catch (err) {
  console.error(err?.message || String(err))
  process.exit(1)
}
