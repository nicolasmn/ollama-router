import { describe, expect, it, jest } from '@jest/globals'
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
      { nodeHost: 'http://node-a:11434', modelName: 'gemma4:e4b', score: 18.447 } as any,
      { nodeHost: 'http://node-b:11434', modelName: 'gemma4:26b', score: 17.2 } as any,
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
    // Privacy: raw prompt text must not appear anywhere in the entry
    expect(JSON.stringify(entry)).not.toContain('Bitte vergleiche Redis und Valkey')
    expect(entry.promptChars).toBe(
      'Bitte vergleiche Redis und Valkey für einen Cache-Layer mit hoher Schreibrate.'.length,
    )
    expect(entry.promptHash).toMatch(/^[0-9a-f]{12}$/u)
    expect(entry.candidates[0].score).toBe(18.45)
    expect(entry.selectedModel).toBe('gemma4:e4b')
    expect(entry.attempts).toHaveLength(1)
    expect(entry.tokensGenerated).toBe(91)
  })

  it('captures prompt metadata but no content for embeddings requests', () => {
    const history = new RequestHistoryManager()

    history.startRequest({
      requestId: 'embed-1',
      endpointType: 'embeddings',
      reqBody: { input: ['hello world', 'another short input'] },
      analysis: { needsEmbeddings: true },
    })

    const [entry] = history.getRecentRequests()
    expect(entry.inputSummary).toBe('2 input items')
    // 'hello world | another short input'
    expect(entry.promptChars).toBe(33)
    expect(entry.promptHash).toMatch(/^[0-9a-f]{12}$/u)
    expect(JSON.stringify(entry)).not.toContain('hello world')
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

  it('starts requests as waiting and updates active status from attempts', () => {
    const history = new RequestHistoryManager()

    history.startRequest({
      requestId: 'req-waiting',
      endpointType: 'chat',
      reqBody: { messages: [{ role: 'user', content: 'hello' }] },
      analysis: {},
    })

    history.recordAttempt('req-waiting', {
      nodeHost: 'http://node-a:11434',
      modelName: 'gemma4:e4b',
      status: 'waiting',
    })

    const [waitingEntry] = history.getRecentRequests()
    expect(waitingEntry.status).toBe('waiting')

    history.recordAttempt('req-waiting', {
      nodeHost: 'http://node-a:11434',
      modelName: 'gemma4:e4b',
      status: 'running',
    })

    const [runningEntry] = history.getRecentRequests()
    expect(runningEntry.status).toBe('running')
    expect(runningEntry.attempts).toHaveLength(1)
  })

  it('appends final assistant response content for chat requests', () => {
    const history = new RequestHistoryManager()

    history.startRequest({
      requestId: 'req-response',
      endpointType: 'chat',
      reqBody: { messages: [{ role: 'user', content: 'Summarize this text.' }] },
      analysis: {},
    })

    const updated = history.updateResponseContent(
      'req-response',
      'Here is the concise summary.',
    )

    expect(updated).toBe(true)

    const detail = history.getRequestDetail('req-response')
    const assistantMessage = detail!.messageList.at(-1)
    expect(assistantMessage).toEqual({
      role: 'assistant',
      content: 'Here is the concise summary.',
    })
  })

  it('tracks queue wait and execution duration separately', () => {
    const history = new RequestHistoryManager()
    let now = 1000
    const dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now)

    try {
      history.startRequest({
        requestId: 'req-latency',
        endpointType: 'chat',
        reqBody: { messages: [{ role: 'user', content: 'hello' }] },
        analysis: {},
      })

      now += 120
      history.recordAttempt('req-latency', {
        nodeHost: 'http://node-a:11434',
        modelName: 'gemma4:e4b',
        status: 'waiting',
        attemptReason: 'first_try',
      })

      now += 30
      history.finishRequest('req-latency', {
        status: 'success',
        responseStatus: 200,
        latency: 30,
      })
    } finally {
      dateNowSpy.mockRestore()
    }

    const [entry] = history.getRecentRequests()
    expect(entry.queueWaitMs).toBe(120)
    expect(entry.executionTimeMs).toBe(30)
    expect(entry.attempts[0].attemptReason).toBe('first_try')
  })

  it('stores abort reason, failure category and retry hint', () => {
    const history = new RequestHistoryManager()

    history.startRequest({
      requestId: 'req-insights',
      endpointType: 'chat',
      reqBody: { messages: [{ role: 'user', content: 'hello' }] },
      analysis: {},
    })

    history.finishRequest('req-insights', {
      status: 'aborted',
      abortReason: 'client_disconnect',
      failureCategory: 'client_abort',
      retryHint: 'no_retry',
    })

    const [entry] = history.getRecentRequests()
    expect(entry.abortReason).toBe('client_disconnect')
    expect(entry.failureCategory).toBe('client_abort')
    expect(entry.retryHint).toBe('no_retry')
  })

  it('records model load time reported by Ollama', () => {
    const history = new RequestHistoryManager()

    history.startRequest({
      requestId: 'req-load',
      endpointType: 'chat',
      reqBody: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
      analysis: {},
    })

    let [entry] = history.getRecentRequests()
    expect(entry.modelLoadMs).toBe(0)

    history.finishRequest('req-load', {
      status: 'success',
      responseStatus: 200,
      latency: 4200,
      modelLoadMs: 3400,
    })

    ;[entry] = history.getRecentRequests()
    expect(entry.modelLoadMs).toBe(3400)
  })

  it('extracts thinking from streamed reasoning chunks', () => {
    const history = new RequestHistoryManager()

    history.startRequest({
      requestId: 'req-stream-thinking',
      endpointType: 'chat',
      reqBody: { messages: [{ role: 'user', content: 'plan this' }] },
      analysis: {},
    })

    const updated = history.updateResponseFromSSE(
      'req-stream-thinking',
      [
        'data: {"choices":[{"delta":{"reasoning_content":"Step 1"}}]}',
        'data:{"choices":[{"delta":{"content":" Final answer"}}]}',
        'data: [DONE]',
      ].join('\n'),
    )

    expect(updated).toBe(true)
    const assistantMessage = history.getRequestDetail('req-stream-thinking')!.messageList.at(-1)
    expect(assistantMessage).toEqual({
      role: 'assistant',
      content: 'Final answer',
      thinking: 'Step 1',
    })
  })

  it('extracts <think> blocks from assistant content', () => {
    const history = new RequestHistoryManager()

    history.startRequest({
      requestId: 'req-think-tags',
      endpointType: 'chat',
      reqBody: { messages: [{ role: 'user', content: 'solve this' }] },
      analysis: {},
    })

    const updated = history.updateResponseContent('req-think-tags', {
      message: {
        role: 'assistant',
        content: '<think>internal analysis</think>Final answer',
      },
    })

    expect(updated).toBe(true)
    const assistantMessage = history.getRequestDetail('req-think-tags')!.messageList.at(-1)
    expect(assistantMessage).toEqual({
      role: 'assistant',
      content: 'Final answer',
      thinking: 'internal analysis',
    })
  })

  it('applies streaming delta events incrementally', () => {
    const history = new RequestHistoryManager()

    history.startRequest({
      requestId: 'req-live-stream',
      endpointType: 'chat',
      reqBody: { messages: [{ role: 'user', content: 'hello' }] },
      analysis: {},
    })

    const first = history.applyStreamingEvent('req-live-stream', {
      choices: [{ delta: { role: 'assistant', content: 'Hel' } }],
    })
    expect(first).toBe(true)

    let detail = history.getRequestDetail('req-live-stream')!
    expect(detail.messageList.at(-1)).toEqual({ role: 'assistant', content: 'Hel' })

    const second = history.applyStreamingEvent('req-live-stream', {
      choices: [{ delta: { content: 'lo', reasoning_content: 'thinking...' } }],
    })
    expect(second).toBe(true)

    history.finalizeStreamingResponse('req-live-stream')
    detail = history.getRequestDetail('req-live-stream')!
    expect(detail.messageList.at(-1)).toEqual({
      role: 'assistant',
      content: 'Hello',
      thinking: 'thinking...',
    })
  })

  it('accumulates Ollama /api/generate streaming chunks into messageList', () => {
    const history = new RequestHistoryManager()

    history.startRequest({
      requestId: 'req-ollama-generate',
      endpointType: 'generate',
      reqBody: { model: 'llama3.2', prompt: 'Why is the sky blue?' },
      analysis: {},
    })

    const first = history.applyStreamingEvent('req-ollama-generate', {
      model: 'llama3.2',
      response: 'The sky',
      done: false,
    })
    expect(first).toBe(true)

    const second = history.applyStreamingEvent('req-ollama-generate', {
      model: 'llama3.2',
      response: ' is blue.',
      done: false,
    })
    expect(second).toBe(true)

    // Final done chunk carries no text — should be a no-op
    const done = history.applyStreamingEvent('req-ollama-generate', {
      model: 'llama3.2',
      response: '',
      done: true,
    })
    expect(done).toBe(false)

    history.finalizeStreamingResponse('req-ollama-generate')

    const detail = history.getRequestDetail('req-ollama-generate')!
    expect(detail.messageList.at(-1)).toEqual({
      role: 'assistant',
      content: 'The sky is blue.',
    })
  })

  it('accumulates Ollama /api/chat streaming chunks into messageList', () => {
    const history = new RequestHistoryManager()

    history.startRequest({
      requestId: 'req-ollama-chat',
      endpointType: 'chat',
      reqBody: {
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'Count to three.' }],
      },
      analysis: {},
    })

    history.applyStreamingEvent('req-ollama-chat', {
      model: 'llama3.2',
      message: { role: 'assistant', content: 'One' },
      done: false,
    })

    history.applyStreamingEvent('req-ollama-chat', {
      model: 'llama3.2',
      message: { role: 'assistant', content: ', two' },
      done: false,
    })

    history.applyStreamingEvent('req-ollama-chat', {
      model: 'llama3.2',
      message: { role: 'assistant', content: ', three.' },
      done: false,
    })

    // done sentinel with empty content
    const doneSentinel = history.applyStreamingEvent('req-ollama-chat', {
      model: 'llama3.2',
      message: { role: 'assistant', content: '' },
      done: true,
    })
    expect(doneSentinel).toBe(false)

    history.finalizeStreamingResponse('req-ollama-chat')

    const detail = history.getRequestDetail('req-ollama-chat')!
    expect(detail.messageList.at(-1)).toEqual({
      role: 'assistant',
      content: 'One, two, three.',
    })
  })

  it('returns false for unrecognised streaming payloads (heartbeats)', () => {
    const history = new RequestHistoryManager()

    history.startRequest({
      requestId: 'req-heartbeat',
      endpointType: 'chat',
      reqBody: { messages: [{ role: 'user', content: 'hello' }] },
      analysis: {},
    })

    // Empty object — no delta, no response, no message
    expect(history.applyStreamingEvent('req-heartbeat', {})).toBe(false)
    // Unknown top-level shape
    expect(history.applyStreamingEvent('req-heartbeat', { type: 'ping' })).toBe(false)

    // Messages live in the private thread store; assert no assistant message
    // was appended by the no-op events
    const detail = history.getRequestDetail('req-heartbeat')!
    expect(detail.messageList.every((m) => m.role !== 'assistant')).toBe(true)
  })

  it('keeps raw prompt content out of dashboard entries (privacy)', () => {
    const secret =
      'Top secret WhatsApp message: meet me at 5pm behind the old bridge edge case 42x'
    const history = new RequestHistoryManager()

    history.startRequest({
      requestId: 'req-privacy',
      endpointType: 'chat',
      reqBody: { messages: [{ role: 'user', content: secret }] },
      analysis: {},
    })

    const [entry] = history.getRecentRequests()
    const serialized = JSON.stringify(entry)
    // No prompt text anywhere in the entry — not even as a substring
    expect(serialized).not.toContain(secret)
    expect(serialized.toLowerCase()).not.toContain('behind the old bridge')

    // …but length and hash are retained
    expect(entry.promptChars).toBe(secret.length)
    expect(entry.promptHash).toMatch(/^[0-9a-f]{12}$/u)
    expect(entry.messageCount).toBe(1)
    // Neutral conversation label, no content leak
    expect(entry.conversationLabel).not.toContain('WhatsApp message')
    expect(entry.conversationSource).toBe('derived')

    // The private thread store still serves the content on demand (detail API)
    const detail = history.getRequestDetail('req-privacy')!
    expect(detail.messageList[0].content).toBe(secret)
  })
})
