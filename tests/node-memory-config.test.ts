import { describe, it, expect } from '@jest/globals'
import { parseNodeMemoryGb, resolveNodeMemoryBytes } from '../src/config.js'

const GB = 1024 ** 3

describe('parseNodeMemoryGb', () => {
  it('returns no entries when unset or empty', () => {
    expect(parseNodeMemoryGb(undefined)).toEqual([])
    expect(parseNodeMemoryGb('')).toEqual([])
  })

  it('parses comma-separated host=GB pairs', () => {
    const entries = parseNodeMemoryGb('192.168.1.20=64, mac-studio.local=32')
    expect(entries).toEqual([
      { hostname: '192.168.1.20', port: '', bytes: 64 * GB },
      { hostname: 'mac-studio.local', port: '', bytes: 32 * GB },
    ])
  })

  it('accepts keys with scheme and port, and fractional GB', () => {
    const [entry] = parseNodeMemoryGb('http://Mac.Local:11434=7.5')
    expect(entry).toEqual({ hostname: 'mac.local', port: '11434', bytes: 7.5 * GB })
  })

  it('ignores malformed, non-numeric and non-positive entries', () => {
    expect(parseNodeMemoryGb('nohost,a=abc,b=0,c=-4,=16,d=')).toEqual([])
  })
})

describe('resolveNodeMemoryBytes', () => {
  const entries = parseNodeMemoryGb('192.168.1.20=64,mac-studio.local=32,10.0.0.5:11435=8,10.0.0.5=16')

  it('matches a node URL by bare IP', () => {
    expect(resolveNodeMemoryBytes(entries, 'http://192.168.1.20:11434')).toBe(64 * GB)
  })

  it('matches by hostname case-insensitively', () => {
    expect(resolveNodeMemoryBytes(entries, 'http://Mac-Studio.local:11434')).toBe(32 * GB)
  })

  it('prefers a port-specific entry over a host-only one', () => {
    expect(resolveNodeMemoryBytes(entries, 'http://10.0.0.5:11435')).toBe(8 * GB)
    expect(resolveNodeMemoryBytes(entries, 'http://10.0.0.5:11434')).toBe(16 * GB)
  })

  it('does not match a port-restricted entry on another port', () => {
    const only = parseNodeMemoryGb('10.0.0.5:11435=8')
    expect(resolveNodeMemoryBytes(only, 'http://10.0.0.5:11434')).toBeNull()
  })

  it('returns null for unknown hosts and unparseable URLs', () => {
    expect(resolveNodeMemoryBytes(entries, 'http://10.9.9.9:11434')).toBeNull()
    expect(resolveNodeMemoryBytes(entries, '')).toBeNull()
  })
})
