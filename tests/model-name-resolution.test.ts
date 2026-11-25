import { describe, it, expect } from '@jest/globals'
import { resolveModelName } from '../src/models.js'

describe('resolveModelName', () => {
  it('returns an exact known name unchanged', () => {
    expect(resolveModelName('inkling-2-mini:latest', ['inkling-2-mini:latest'])).toBe('inkling-2-mini:latest')
  })

  it('prefers :latest for a tagless name', () => {
    expect(resolveModelName('inkling-2-mini', ['inkling-2-mini:7b', 'inkling-2-mini:latest'])).toBe('inkling-2-mini:latest')
  })

  it('matches another installed tag when :latest is absent', () => {
    expect(resolveModelName('nimble-v3', ['other:latest', 'nimble-v3:7b'])).toBe('nimble-v3:7b')
  })

  it('does not fuzzy-match explicit tags or digests', () => {
    expect(resolveModelName('nimble-v3:9b', ['nimble-v3:7b', 'nimble-v3:latest'])).toBe('nimble-v3:9b')
    expect(resolveModelName('nimble-v3@sha256:abc', ['nimble-v3:7b'])).toBe('nimble-v3@sha256:abc')
  })

  it('returns unknown tagless names unchanged', () => {
    expect(resolveModelName('unknown', ['other:latest'])).toBe('unknown')
  })
})
