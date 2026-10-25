import { describe, it, expect } from '@jest/globals'
import { RequestAnalyzer } from '../src/request-analyzer.js'

const analyzer = new RequestAnalyzer()

describe('RequestAnalyzer', () => {
  describe('embeddings', () => {
    it('detects embedding requests', () => {
      const result = analyzer.analyze({ input: 'hello' }, 'embeddings')
      expect(result.needsEmbeddings).toBe(true)
      expect(result.needsTools).toBe(false)
      expect(result.isStreaming).toBe(false)
      expect(result.preferFast).toBe(true)
      expect(result.messageCount).toBe(0)
    })
  })

  describe('tools detection', () => {
    it('detects tools in request', () => {
      const result = analyzer.analyze(
        {
          messages: [{ role: 'user', content: 'hello' }],
          tools: [{ type: 'function', function: { name: 'x' } }],
        },
        'chat',
      )
      expect(result.needsTools).toBe(true)
    })

    it('does not flag tools when array is empty', () => {
      const result = analyzer.analyze(
        { messages: [{ role: 'user', content: 'hello' }], tools: [] },
        'chat',
      )
      expect(result.needsTools).toBe(false)
    })

    it('still marks preferFast for simple tool requests with trivial content', () => {
      const result = analyzer.analyze(
        {
          messages: [
            { role: 'system', content: '[Incoming message from agent] dispatch test ok' },
          ],
          tools: [{ type: 'function', function: { name: 'send_message' } }],
        },
        'chat',
      )
      expect(result.needsTools).toBe(true)
      expect(result.preferFast).toBe(true)
      expect(result.preferReasoning).toBe(false)
    })
  })

  describe('vision detection', () => {
    it('detects image_url content', () => {
      const result = analyzer.analyze(
        {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'describe this' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } },
              ],
            },
          ],
        },
        'chat',
      )
      expect(result.needsVision).toBe(true)
    })

    it('detects top-level images on native generate requests', () => {
      const result = analyzer.analyze(
        {
          model: 'llava',
          prompt: 'what is in this image?',
          images: ['iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='],
        },
        'generate',
      )
      expect(result.needsVision).toBe(true)
    })

    it('detects top-level images on native chat requests', () => {
      const result = analyzer.analyze(
        {
          model: 'llava',
          messages: [{ role: 'user', content: 'what is in this image?' }],
          images: ['iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='],
        },
        'chat',
      )
      expect(result.needsVision).toBe(true)
    })

    it('detects per-message images on native chat requests', () => {
      const result = analyzer.analyze(
        {
          model: 'llava',
          messages: [
            {
              role: 'user',
              content: 'what is in this image?',
              images: ['iVBORw0KGgoAAAANSUhEUgAAAAEA...'],
            },
          ],
        },
        'chat',
      )
      expect(result.needsVision).toBe(true)
    })

    it('does not flag vision for plain text', () => {
      const result = analyzer.analyze(
        { messages: [{ role: 'user', content: 'hello' }] },
        'chat',
      )
      expect(result.needsVision).toBe(false)
    })
  })

  describe('streaming detection', () => {
    it('detects streaming requests', () => {
      const result = analyzer.analyze(
        { messages: [{ role: 'user', content: 'hi' }], stream: true },
        'chat',
      )
      expect(result.isStreaming).toBe(true)
    })

    it('non-streaming by default', () => {
      const result = analyzer.analyze(
        { messages: [{ role: 'user', content: 'hi' }] },
        'chat',
      )
      expect(result.isStreaming).toBe(false)
    })
  })

  describe('complexity flags', () => {
    it('marks preferFast for short simple messages', () => {
      const result = analyzer.analyze(
        { messages: [{ role: 'user', content: 'hi' }] },
        'chat',
      )
      expect(result.preferFast).toBe(true)
      expect(result.messageCount).toBe(1)
    })

    it('marks preferReasoning for analytical queries', () => {
      const result = analyzer.analyze(
        {
          messages: [
            {
              role: 'user',
              content:
                'Please analyze and compare the two approaches in detail with step by step reasoning',
            },
          ],
        },
        'chat',
      )
      expect(result.preferReasoning).toBe(true)
      expect(result.preferFast).toBe(false)
    })

    it('marks preferReasoning for German analytical queries', () => {
      const result = analyzer.analyze(
        {
          messages: [
            {
              role: 'user',
              content:
                'Bitte erkläre und vergleiche die beiden Ansätze. Begründe, welche Variante unter diesen Randbedingungen sinnvoller ist.',
            },
          ],
        },
        'chat',
      )
      expect(result.preferReasoning).toBe(true)
      expect(result.preferFast).toBe(false)
    })

    it('marks preferReasoning for structured multi-part prompts without English keywords', () => {
      const result = analyzer.analyze(
        {
          messages: [
            {
              role: 'user',
              content:
                'API-Entscheidung:\n1. serverseitige Sessions\n2. JWT mit Rotation\nRandbedingungen: mehrere Services, Audit-Logs, kurze Timeouts.\nWelche Risiken siehst du? Welche Variante ist robuster?',
            },
          ],
        },
        'chat',
      )
      expect(result.preferReasoning).toBe(true)
    })

    it('marks preferReasoning for code content', () => {
      const result = analyzer.analyze(
        { messages: [{ role: 'user', content: 'function add(a, b) { return a + b }' }] },
        'chat',
      )
      expect(result.preferReasoning).toBe(true)
    })

    it('does not mark preferFast for long conversations even with simple messages', () => {
      const messages = Array.from({ length: 12 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: 'hi',
      }))
      const result = analyzer.analyze({ messages }, 'chat')
      expect(result.preferFast).toBe(false)
      expect(result.messageCount).toBe(12)
    })
  })

  describe('token estimation', () => {
    it('estimates input tokens from message content', () => {
      const longMessage = 'word '.repeat(400)
      const result = analyzer.analyze(
        { messages: [{ role: 'user', content: longMessage }] },
        'chat',
      )
      expect(result.estimatedInputTokens).toBeGreaterThan(300)
    })
  })
})
