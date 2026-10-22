#!/usr/bin/env node
// scripts/copy-dashboard-assets.js
// Deterministically copies all static dashboard assets to dist/.
// Called as part of the build pipeline; has no external dependencies.

import { cpSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const SRC = join(ROOT, 'src', 'dashboard')
const DEST = join(ROOT, 'dist', 'src', 'dashboard')

mkdirSync(DEST, { recursive: true })

const files = ['index.html', 'styles.css', 'favicon.svg', 'logo.svg']
for (const file of files) {
  cpSync(join(SRC, file), join(DEST, file))
}

// styles/ sub-directory
cpSync(join(SRC, 'styles'), join(DEST, 'styles'), { recursive: true })

// vendor/ sub-directory (microlighter: highlighter + themes + on-demand grammars)
cpSync(join(SRC, 'vendor'), join(DEST, 'vendor'), { recursive: true })

console.log('Dashboard assets copied to dist/src/dashboard/')
