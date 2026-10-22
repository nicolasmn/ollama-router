import { describe, it, expect, jest, beforeEach } from '@jest/globals'

// ESM-compatible mocking: must use unstable_mockModule + dynamic import
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockRequest = jest.fn<(...args: any[]) => any>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCreateConnection = jest.fn<(...args: any[]) => any>()

jest.unstable_mockModule('undici', () => ({ request: mockRequest }))
jest.unstable_mockModule('node:net', () => ({
  createConnection: mockCreateConnection,
}))

// Dynamic import MUST follow unstable_mockModule calls so the scanner
// module picks up the mocked dependencies when it is first evaluated.
const { NetworkScanner } = await import('../src/network-scanner.js')

// ── helpers ──────────────────────────────────────────────────────────────────

type SocketEmitter = {
  once(event: string, fn: () => void): SocketEmitter
  destroy(): void
  setTimeout(ms: number): void
}

function makeSocket(triggerEvent: 'connect' | 'error'): SocketEmitter {
  const handlers: Record<string, () => void> = {}
  const emitter: SocketEmitter = {
    once(event, fn) {
      handlers[event] = fn
      return emitter
    },
    destroy: jest.fn() as () => void,
    setTimeout: jest.fn() as (ms: number) => void,
  }
  setImmediate(() => handlers[triggerEvent]?.())
  return emitter
}

function makeTcpOpen() {
  mockCreateConnection.mockImplementation(() => makeSocket('connect'))
}

function makeTcpClosed() {
  mockCreateConnection.mockImplementation(() => makeSocket('error'))
}

function makeHttpResponse(
  statusCode: number,
  headers: Record<string, string> = {},
) {
  mockRequest.mockResolvedValue({
    statusCode,
    headers,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    body: {
      dump: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
    },
  })
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('NetworkScanner._buildCandidates', () => {
  const scanner = new NetworkScanner()

  it('generates 254 candidates for a /24 subnet', () => {
    const candidates = scanner._buildCandidates('192.168.1')
    expect(candidates).toHaveLength(254)
    expect(candidates[0]).toBe('http://192.168.1.1:11434')
    expect(candidates[253]).toBe('http://192.168.1.254:11434')
  })
})

describe('NetworkScanner._getLocalSubnets', () => {
  it('returns an array of strings', () => {
    const scanner = new NetworkScanner()
    const subnets = scanner._getLocalSubnets()
    expect(Array.isArray(subnets)).toBe(true)
    for (const s of subnets) {
      expect(typeof s).toBe('string')
      // Each subnet prefix has exactly two dots (e.g. "192.168.1")
      expect(s.split('.').length).toBe(3)
    }
  })
})

describe('NetworkScanner — router instance filtering', () => {
  let scanner: InstanceType<typeof NetworkScanner>

  beforeEach(() => {
    scanner = new NetworkScanner()
    jest.clearAllMocks()
  })

  it('accepts a genuine Ollama host (no x-ollama-router header)', async () => {
    jest.spyOn(scanner, '_getLocalSubnets').mockReturnValue(['192.168.99'])
    makeTcpOpen()
    makeHttpResponse(200, {})

    const result = await scanner.scanLocalNetwork()
    expect(result.some((u: string) => u.includes('192.168.99'))).toBe(true)
  })

  it('rejects a host that responds with x-ollama-router header', async () => {
    jest.spyOn(scanner, '_getLocalSubnets').mockReturnValue(['192.168.99'])
    makeTcpOpen()
    makeHttpResponse(200, { 'x-ollama-router': '1' })

    const result = await scanner.scanLocalNetwork()
    expect(result).toHaveLength(0)
  })

  it('rejects a host that returns non-200 status', async () => {
    jest.spyOn(scanner, '_getLocalSubnets').mockReturnValue(['192.168.99'])
    makeTcpOpen()
    makeHttpResponse(404, {})

    const result = await scanner.scanLocalNetwork()
    expect(result).toHaveLength(0)
  })

  it('returns empty array when TCP port is closed', async () => {
    jest.spyOn(scanner, '_getLocalSubnets').mockReturnValue(['192.168.99'])
    makeTcpClosed()

    const result = await scanner.scanLocalNetwork()
    expect(result).toHaveLength(0)
    expect(mockRequest).not.toHaveBeenCalled()
  })

  it('returns empty array when no subnets are found', async () => {
    jest.spyOn(scanner, '_getLocalSubnets').mockReturnValue([])

    const result = await scanner.scanLocalNetwork()
    expect(result).toHaveLength(0)
    expect(mockRequest).not.toHaveBeenCalled()
  })

  it('returns empty array when HTTP request throws', async () => {
    jest.spyOn(scanner, '_getLocalSubnets').mockReturnValue(['10.0.0'])
    makeTcpOpen()
    mockRequest.mockRejectedValue(new Error('connection refused'))

    const result = await scanner.scanLocalNetwork()
    expect(result).toHaveLength(0)
  })
})
