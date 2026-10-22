import { describe, expect, it } from '@jest/globals'
import { RequestHistoryManager } from '../src/request-history.js'

// Regression tests for the memory-growth bug: the router used to copy the full
// inbound conversation (uncapped message text, base64 images, tool payloads)
// into every history entry for the last N requests. A client resending a
// growing transcript (agent loops, chat UIs with history) then pushed the
// Node heap past its limit and the service SIGABRT-crashed into a systemd
// restart (~"reached heap limit Allocation failed" in the journal).

function oversizedMessages(messageCount: number, bodyChars: number) {
  return Array.from({ length: messageCount }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `message ${i}: ${'x'.repeat(bodyChars)}`,
  }))
}

describe('RequestHistoryManager retention caps', () => {
  it('caps per-message content in the captured message list', () => {
    const history = new RequestHistoryManager()

    history.startRequest({
      requestId: 'req-cap-content',
      endpointType: 'chat',
      reqBody: {
        messages: [{ role: 'user', content: 'big: ' + 'a'.repeat(200_000) }],
      },
      analysis: {},
    })

    const [entry] = history.getRecentRequests()
    expect(entry.messageList[0].content).toContain('[truncated,')
    expect(entry.messageList[0].content.length).toBeLessThan(10_000)

    // promptPreview is capped too
    expect(entry.promptPreview.length).toBeLessThan(10_000)
  })

  it('caps the total payload of a single request entry', () => {
    const history = new RequestHistoryManager()

    history.startRequest({
      requestId: 'req-cap-entry',
      endpointType: 'chat',
      reqBody: {
        messages: oversizedMessages(5_000, 10_000), // ~50MB if uncapped
      },
      analysis: {},
    })

    const [entry] = history.getRecentRequests()
    const serialized = JSON.stringify(entry.messageList)
    expect(entry.messageList.length).toBeLessThan(5_000)
    expect(serialized.length).toBeLessThan(600_000) // budget 512k + marker row
    // newest messages survive the trim
    expect(entry.messageList.at(-1)!.role).toBe('assistant')
    expect(entry.messageList[0].role).toBe('system')
  })

  it('caps base64 image payloads', () => {
    const history = new RequestHistoryManager()
    const hugeImage = `data:image/png;base64,${'B'.repeat(500_000)}`

    history.startRequest({
      requestId: 'req-cap-images',
      endpointType: 'chat',
      reqBody: {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this?' },
              { type: 'image', image: hugeImage },
            ],
          },
        ],
      },
      analysis: {},
    })

    const [entry] = history.getRecentRequests()
    const images = (entry.messageList[0] as any).images
    expect(images).toHaveLength(1)
    expect(images[0].url).toContain('truncated')
    expect(images[0].url.length).toBeLessThan(70_000)
  })

  it('caps cumulative streamed assistant output', () => {
    const history = new RequestHistoryManager()

    history.startRequest({
      requestId: 'req-cap-stream',
      endpointType: 'chat',
      reqBody: { messages: [{ role: 'user', content: 'hi' }] },
      analysis: {},
    })

    const giantChunk = 'y'.repeat(5_000)
    for (let i = 0; i < 5_000; i++) {
      history.applyStreamingEvent('req-cap-stream', {
        choices: [{ delta: { content: giantChunk } }],
      })
    }

    const [entry] = history.getRecentRequests()
    const assistant = entry.messageList.at(-1)!
    expect(assistant.content).toContain('[truncated]')
    expect(assistant.content.length).toBeLessThan(70_000)
  })

  it('keeps streaming captures across successive conversation growth bounded', () => {
    // Simulate an agent loop: each turn resends the whole transcript, longer.
    const history = new RequestHistoryManager({ limit: 40 })
    let transcript: Array<Record<string, unknown>> = []
    for (let turn = 0; turn < 60; turn++) {
      transcript = [
        ...transcript,
        { role: 'user', content: 'turn: ' + 'z'.repeat(20_000) },
        { role: 'assistant', content: 'reply: ' + 'w'.repeat(20_000) },
      ]
      const requestId = `req-agent-${turn}`
      history.startRequest({
        requestId,
        endpointType: 'chat',
        reqBody: { messages: transcript },
        analysis: {},
      })
      history.finishRequest(requestId, {
        status: 'success',
        responseStatus: 200,
        latency: 10,
      })
      history.applyStreamingEvent(requestId, {
        choices: [{ delta: { content: 'answer ' + 'q'.repeat(2_000) } }],
      })
      history.finalizeStreamingResponse(requestId)
    }

    const serialized = JSON.stringify(history.requests)
    // ~28MB would be uncapped; the cap keeps this at a few MB.
    expect(serialized.length).toBeLessThan(30 * 1024 * 1024)
    expect(serialized.length).toBeGreaterThan(0)
  })
})
