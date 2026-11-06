#!/usr/bin/env node
// scripts/service-linux.js - Linux systemd service CLI
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
const APP_USER = 'ollama-router'
const INSTALL_DIR = '/opt/ollama-router'
const DATA_DIR = '/var/lib/ollama-router'
const ENV_FILE = '/etc/ollama-router.env'
const SERVICE_FILE = `/etc/systemd/system/${APP_NAME}.service`

const STATUS_EXIT_RUNNING = 0
const STATUS_EXIT_STOPPED = 1
const STATUS_EXIT_ERROR = 2

const APP_VERSION = readVersion()

function readVersion() {
  try {
    const raw = readFileSync(join(SOURCE_DIR, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw)
    return pkg.version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

// ---------------------------------------------------------------------------
// Unit file and default env builders
// ---------------------------------------------------------------------------

function buildUnit() {
  return `[Unit]
Description=Ollama Router
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/env node ${INSTALL_DIR}/dist/index.js
Restart=always
RestartSec=5
# Node drains in-flight inference on SIGTERM (up to 14 min node-side, DRAIN_TIMEOUT_MS
# in index.ts); this must stay above that so systemd does not SIGKILL mid-drain.
TimeoutStopSec=900
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=${DATA_DIR}
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
`
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

function systemctl(...args) {
  run('systemctl', args)
}

function assertRoot() {
  if (process.getuid?.() !== 0) {
    console.error('This command must be run with sudo or as root.')
    process.exit(1)
  }
}

function assertLinuxAndSystemd() {
  if (process.platform !== 'linux') {
    console.error('This CLI only supports Linux with systemd.')
    process.exit(1)
  }

  try {
    runCapture('systemctl', ['--version'])
  } catch {
    console.error('systemctl is not available. This CLI requires systemd.')
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

function ensureUser() {
  try {
    execFileSync('id', ['-u', APP_USER], { stdio: 'pipe' })
  } catch {
    run('useradd', [
      '--system',
      '--home',
      INSTALL_DIR,
      '--shell',
      '/usr/sbin/nologin',
      APP_USER,
    ])
  }
}

// Deploy source files and install production dependencies
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

  // 3. Sync compiled JS output (tsc + esbuild write to dist/)
  run('rsync', [
    '-a',
    '--delete',
    `${SOURCE_DIR}/dist/`,
    `${INSTALL_DIR}/dist/`,
  ])

  // 4. Sync dashboard static assets (HTML/CSS — not compiled by tsc/esbuild).
  //    The JS bundle is already in dist/ from the build step above.
  //    Only HTML, CSS, and non-JS assets need to be copied here.
  run('rsync', [
    '-a',
    '--delete',
    '--exclude=*.js',
    `${SOURCE_DIR}/src/dashboard/`,
    `${INSTALL_DIR}/dist/src/dashboard/`,
  ])

  // 5. Install production-only dependencies
  run('cp', [`${SOURCE_DIR}/package.json`, `${INSTALL_DIR}/package.json`])
  run('cp', [
    `${SOURCE_DIR}/package-lock.json`,
    `${INSTALL_DIR}/package-lock.json`,
  ])
  run('npm', ['ci', '--omit=dev', '--prefix', INSTALL_DIR])

  // 6. Fix ownership
  run('chown', ['-R', `${APP_USER}:${APP_USER}`, INSTALL_DIR, DATA_DIR])
}

function assertCommandAvailable(name) {
  try {
    runCapture('which', [name])
  } catch {
    console.error(`${name} was not found in PATH.`)
    process.exit(1)
  }
}

function assertRegistered() {
  if (!existsSync(SERVICE_FILE)) {
    console.error(`Service is not registered yet: ${SERVICE_FILE}`)
    console.error('Run: sudo node scripts/service.js register')
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function register() {
  assertLinuxAndSystemd()
  assertRoot()
  assertSourceDir()

  ensureUser()
  deployFiles()

  // Only create the env file if it does not yet exist — preserves manual edits
  if (!existsSync(ENV_FILE)) {
    writeFileSync(ENV_FILE, buildDefaultEnv(), { mode: 0o640 })
  }

  // Unit file is always overwritten so it stays in sync with this script
  writeFileSync(SERVICE_FILE, buildUnit())

  systemctl('daemon-reload')
  systemctl('enable', '--now', APP_NAME)

  console.log('\nRegistration complete.')
  console.log(`Service status: systemctl status ${APP_NAME}`)
  console.log(`Logs:           journalctl -u ${APP_NAME} -f`)
  console.log(`Health:         curl http://127.0.0.1:8000/health`)
  console.log(`Configuration:  ${ENV_FILE}`)
}

function update() {
  assertLinuxAndSystemd()
  assertRoot()
  assertSourceDir()
  assertRegistered()

  if (!existsSync(INSTALL_DIR)) {
    console.error(`Install directory is missing: ${INSTALL_DIR}`)
    console.error('Please run: sudo node scripts/service.js register')
    process.exit(1)
  }

  if (!existsSync(ENV_FILE)) {
    console.error(`Configuration file is missing: ${ENV_FILE}`)
    console.error('Please run: sudo node scripts/service.js register')
    process.exit(1)
  }

  deployFiles()

  // Keep unit file current on every update
  writeFileSync(SERVICE_FILE, buildUnit())

  systemctl('daemon-reload')
  systemctl('restart', APP_NAME)

  console.log('\nUpdate complete.')
  console.log(`Service status: systemctl status ${APP_NAME}`)
  console.log(`Logs:           journalctl -u ${APP_NAME} -f`)
  console.log(`Health:         curl http://127.0.0.1:8000/health`)
}

function start() {
  assertLinuxAndSystemd()
  assertRoot()
  assertRegistered()
  systemctl('start', APP_NAME)
  console.log(`Service started: ${APP_NAME}`)
}

function stop() {
  assertLinuxAndSystemd()
  assertRoot()
  assertRegistered()
  systemctl('stop', APP_NAME)
  console.log(`Service stopped: ${APP_NAME}`)
}

function restart() {
  assertLinuxAndSystemd()
  assertRoot()
  assertRegistered()
  systemctl('restart', APP_NAME)
  console.log(`Service restarted: ${APP_NAME}`)
}

function status() {
  assertLinuxAndSystemd()

  try {
    const active = runCapture('systemctl', ['is-active', APP_NAME])
    const enabled = runCapture('systemctl', ['is-enabled', APP_NAME])

    console.log(`Service: ${APP_NAME}`)
    console.log(`Active:  ${active}`)
    console.log(`Enabled: ${enabled}`)

    if (active === 'active') {
      process.exit(STATUS_EXIT_RUNNING)
    }

    process.exit(STATUS_EXIT_STOPPED)
  } catch (err) {
    console.error('Failed to query service status.')
    console.error(err?.message || String(err))
    process.exit(STATUS_EXIT_ERROR)
  }
}

function uninstall({ purge = false } = {}) {
  assertLinuxAndSystemd()
  assertRoot()

  try {
    const units = execFileSync('systemctl', ['list-unit-files'], {
      encoding: 'utf8',
    })
    if (units.includes(`${APP_NAME}.service`)) {
      systemctl('disable', '--now', APP_NAME)
    }
  } catch {
    /* service not registered — nothing to stop */
  }

  if (existsSync(SERVICE_FILE)) unlinkSync(SERVICE_FILE)

  try {
    systemctl('daemon-reload')
  } catch {
    /* not critical */
  }
  try {
    systemctl('reset-failed')
  } catch {
    /* not critical */
  }

  if (purge) {
    if (existsSync(INSTALL_DIR))
      rmSync(INSTALL_DIR, { recursive: true, force: true })
    if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true })
    if (existsSync(ENV_FILE)) unlinkSync(ENV_FILE)

    try {
      execFileSync('id', ['-u', APP_USER], { stdio: 'pipe' })
      run('userdel', [APP_USER])
    } catch {
      /* user does not exist */
    }

    console.log(
      '\nUninstall complete. Service, files, data, configuration, and service user removed.',
    )
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

cli.command('register', 'register and start the systemd service').action(() => {
  register()
})

// Backwards-compatible alias
cli.command('install', 'alias for register').action(() => {
  register()
})

cli.command('start', 'start the systemd service').action(() => {
  start()
})

cli.command('stop', 'stop the systemd service').action(() => {
  stop()
})

cli.command('restart', 'restart the systemd service').action(() => {
  restart()
})

cli.command('status', 'show systemd service status').action(() => {
  status()
})

cli.command('update', 'deploy updates and restart service').action(() => {
  update()
})

cli
  .command('uninstall', 'remove systemd registration')
  .option('--purge', 'also remove files, data, config, and service user')
  .action((options) => {
    uninstall({ purge: Boolean(options.purge) })
  })

try {
  cli.parse()
} catch (err) {
  console.error(err?.message || String(err))
  process.exit(1)
}
