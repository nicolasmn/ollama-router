import { describe, expect, it } from '@jest/globals'
import { RequestHistoryManager } from '../src/request-history.js'

describe('RequestHistoryManager', () => {
  it('stores compact request metadata for dashboard inspection', () => {
    const history = new RequestHistoryManager({ limit: 5 })

    history.startRequest({
      requestId: 'req-1',
      endpointType: 'chat',
      reqBody: {
        model: 'auto',
        stream: true,
        messages: [
          { role: 'system', content: 'be concise' },
          {
            role: 'user',
            content:
              'Bitte vergleiche Redis und Valkey für einen Cache-Layer mit hoher Schreibrate.',
          },
        ],
      },
      analysis: {
        preferReasoning: true,
        preferFast: false,
        needsTools: false,
        estimatedInputTokens: 42,
      },
    })

    history.recordSelection('req-1', [
      {
        nodeHost: 'http://node-a:11434',
        modelName: 'gemma4:e4b',
        score: 18.447,
      },
      {
        nodeHost: 'http://node-b:11434',
        modelName: 'gemma4:26b',
        score: 17.2,
      },
    ])
    history.recordAttempt('req-1', {
      nodeHost: 'http://node-a:11434',
      modelName: 'gemma4:e4b',
      status: 'success',
      latency: 280,
    })
    history.finishRequest('req-1', {
      status: 'success',
      responseStatus: 200,
      latency: 280,
      nodeHost: 'http://node-a:11434',
      modelName: 'gemma4:e4b',
      tokensGenerated: 91,
    })

    const [entry] = history.getRecentRequests()
    expect(entry.requestId).toBe('req-1')
    expect(entry.conversationId).toMatch(/^chat:/u)
    expect(entry.conversationSource).toBe('derived')
    expect(entry.promptPreview).toContain('Bitte vergleiche Redis und Valkey')
    expect(entry.candidates[0].score).toBe(18.45)
    expect(entry.selectedModel).toBe('gemma4:e4b')
    expect(entry.attempts).toHaveLength(1)
    expect(entry.tokensGenerated).toBe(91)
  })

  it('creates a useful preview for embeddings requests', () => {
    const history = new RequestHistoryManager()

    history.startRequest({
      requestId: 'embed-1',
      endpointType: 'embeddings',
      reqBody: {
        input: ['hello world', 'another short input'],
      },
      analysis: {
        needsEmbeddings: true,
      },
    })

    const [entry] = history.getRecentRequests()
    expect(entry.inputSummary).toBe('2 input items')
    expect(entry.promptPreview).toContain('hello world')
  })

  it('uses explicit conversation identifiers when present', () => {
    const history = new RequestHistoryManager()

    history.startRequest({
      requestId: 'req-explicit',
      endpointType: 'chat',
      reqBody: {
        conversation_id: 'thread-42',
        messages: [{ role: 'user', content: 'hello there' }],
      },
      analysis: {},
    })

    const [entry] = history.getRecentRequests()
    expect(entry.conversationId).toBe('id:thread-42')
    expect(entry.conversationLabel).toBe('Conversation thread-42')
    expect(entry.conversationSource).toBe('explicit')
  })
})
