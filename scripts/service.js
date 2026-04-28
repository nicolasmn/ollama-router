#!/usr/bin/env node
// scripts/service.js — Raspberry Pi systemd service manager
// Usage: sudo node scripts/service.js <install|update|uninstall> [--purge]

import {
  writeFileSync,
  unlinkSync,
  mkdirSync,
  cpSync,
  rmSync,
  existsSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, basename, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SOURCE_DIR = resolve(__dirname, '..')

const APP_NAME = 'ollama-router'
const APP_USER = 'ollama-router'
const INSTALL_DIR = '/opt/ollama-router'
const DATA_DIR = '/var/lib/ollama-router'
const ENV_FILE = '/etc/ollama-router.env'
const SERVICE_FILE = `/etc/systemd/system/${APP_NAME}.service`

const COPY_EXCLUDE = new Set([
  '.git',
  'node_modules',
  'coverage',
  '.nyc_output',
  '.DS_Store',
  'tests',
])

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
ExecStart=/usr/bin/env node ${INSTALL_DIR}/index.js
Restart=always
RestartSec=5
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

function systemctl(...args) {
  run('systemctl', args)
}

function assertRoot() {
  if (process.getuid?.() !== 0) {
    console.error('This script must be run with sudo or as root.')
    process.exit(1)
  }
}

function assertSourceDir() {
  if (
    !existsSync(join(SOURCE_DIR, 'package.json')) ||
    !existsSync(join(SOURCE_DIR, 'index.js'))
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
  mkdirSync(INSTALL_DIR, { recursive: true })
  mkdirSync(DATA_DIR, { recursive: true })

  cpSync(SOURCE_DIR, INSTALL_DIR, {
    recursive: true,
    filter: (src) => !COPY_EXCLUDE.has(basename(src)),
  })

  const lockFile = join(INSTALL_DIR, 'package-lock.json')
  if (existsSync(lockFile)) {
    run('npm', ['ci', '--omit=dev', '--prefix', INSTALL_DIR])
  } else {
    run('npm', ['install', '--omit=dev', '--prefix', INSTALL_DIR])
  }

  run('chown', ['-R', `${APP_USER}:${APP_USER}`, INSTALL_DIR, DATA_DIR])
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function install() {
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

  console.log('\nInstallation complete.')
  console.log(`Service status: systemctl status ${APP_NAME}`)
  console.log(`Logs:           journalctl -u ${APP_NAME} -f`)
  console.log(`Health:         curl http://127.0.0.1:8000/health`)
  console.log(`Configuration:  ${ENV_FILE}`)
}

function update() {
  assertRoot()
  assertSourceDir()

  if (!existsSync(INSTALL_DIR)) {
    console.error(`Install directory is missing: ${INSTALL_DIR}`)
    console.error('Please run: sudo node scripts/service.js install')
    process.exit(1)
  }

  if (!existsSync(ENV_FILE)) {
    console.error(`Configuration file is missing: ${ENV_FILE}`)
    console.error('Please run: sudo node scripts/service.js install')
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

function uninstall({ purge = false } = {}) {
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

const [cmd, flag] = process.argv.slice(2)

switch (cmd) {
  case 'install':
    install()
    break
  case 'update':
    update()
    break
  case 'uninstall':
    uninstall({ purge: flag === '--purge' })
    break
  default:
    console.log(
      'Usage: sudo node scripts/service.js <install|update|uninstall> [--purge]',
    )
    process.exit(1)
}
