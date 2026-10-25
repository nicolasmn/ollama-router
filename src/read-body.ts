// read-body.ts - Read and parse the request body as a stream, once.
// Used instead of relying solely on the global express.json() middleware so
// large bodies are only parsed in routes that actually need them, and without
// a hard 10 MB cap. Falls back to req.body when a body parser (e.g. express.json)
// has already consumed the stream, which keeps compatibility with tests and
// any middleware that pre-parses the body.
import { IncomingMessage } from 'node:http'

export interface ParsedBody {
  body: Record<string, unknown>
  /** Raw body bytes, or null when the body was already parsed by middleware. */
  raw: Buffer | null
}

export async function readJsonBody(req: IncomingMessage): Promise<ParsedBody> {
  // A body parser may have already populated req.body (e.g. express.json() in
  // test harnesses). Reuse it instead of re-reading an already-consumed stream.
  const existing = (req as unknown as Record<string, unknown>).body
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    return { body: existing as Record<string, unknown>, raw: null }
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      let body: Record<string, unknown>
      try {
        body = JSON.parse(raw.toString('utf8') || '{}') ?? {}
      } catch {
        body = {}
      }
      resolve({ body, raw })
    })
    req.on('error', reject)
  })
}
