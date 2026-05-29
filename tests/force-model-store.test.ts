import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import { ForceModelStore } from '../src/force-model-store.js'

const TTL_MS = 10 * 60 * 1000 // must match store constant

describe('ForceModelStore', () => {
  let store: ForceModelStore

  beforeEach(() => {
    jest.useFakeTimers()
    store = new ForceModelStore()
  })

  afterEach(() => {
    store.clear()
    jest.useRealTimers()
  })

  describe('set / get', () => {
    it('returns null when nothing set', () => {
      expect(store.get()).toBeNull()
    })

    it('returns entry after set', () => {
      store.set('mistral:7b')
      const entry = store.get()
      expect(entry).not.toBeNull()
      expect(entry!.model).toBe('mistral:7b')
      expect(entry!.expiresAt).toBeGreaterThan(Date.now())
    })

    it('overwrites previous override on repeated set', () => {
      store.set('model-a')
      store.set('model-b')
      expect(store.get()!.model).toBe('model-b')
    })
  })

  describe('consume', () => {
    it('returns model name on consume', () => {
      store.set('gemma4:e4b')
      expect(store.consume()).toBe('gemma4:e4b')
    })

    it('clears entry after consume — one-shot enforcement', () => {
      store.set('gemma4:e4b')
      store.consume()
      expect(store.get()).toBeNull()
    })

    it('second consume returns null', () => {
      store.set('gemma4:e4b')
      store.consume()
      expect(store.consume()).toBeNull()
    })

    it('returns null when nothing set', () => {
      expect(store.consume()).toBeNull()
    })
  })

  describe('clear', () => {
    it('clears entry immediately', () => {
      store.set('qwen2.5:7b')
      store.clear()
      expect(store.get()).toBeNull()
    })

    it('clear on empty store is a no-op', () => {
      expect(() => store.clear()).not.toThrow()
      expect(store.get()).toBeNull()
    })
  })

  describe('TTL expiry', () => {
    it('get returns null after TTL elapses', () => {
      store.set('llama3:8b')
      jest.advanceTimersByTime(TTL_MS + 1)
      expect(store.get()).toBeNull()
    })

    it('consume returns null after TTL elapses', () => {
      store.set('llama3:8b')
      jest.advanceTimersByTime(TTL_MS + 1)
      expect(store.consume()).toBeNull()
    })

    it('entry still valid just before TTL boundary', () => {
      store.set('llama3:8b')
      jest.advanceTimersByTime(TTL_MS - 100)
      expect(store.get()).not.toBeNull()
    })

    it('setTimeout fires and auto-clears entry at TTL', () => {
      store.set('llama3:8b')
      expect(store.get()).not.toBeNull()
      jest.runAllTimers()
      expect(store.get()).toBeNull()
    })
  })
})
