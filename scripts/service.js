#!/usr/bin/env node
// Platform dispatcher — forwards to the OS-specific service module.

const { platform } = process

const modules = {
  linux: './service-linux.js',
  darwin: './service-darwin.js',
  win32: './service-win32.js',
}

const mod = modules[platform]
if (!mod) {
  console.error(`Unsupported platform: ${platform}`)
  console.error('Supported: linux, darwin (macOS), win32 (Windows)')
  process.exit(1)
}

await import(mod)
