// node-memory.ts - Learns a node's usable memory and loaded-model limit from
// consecutive GET /api/ps snapshots (Ollama reports neither directly).
import type { LoadedModel, NodeMemoryLearning } from './models.js'

/** Ollama's default OLLAMA_MAX_LOADED_MODELS per GPU; the GPU count is invisible to the router. */
export const DEFAULT_MAX_LOADED_MODELS = 3

export type MemorySource = 'config' | 'learned'

const sum = (models: readonly LoadedModel[], pick: (m: LoadedModel) => number): number =>
  models.reduce((total, m) => total + pick(m), 0)

/**
 * Folds a successful /api/ps snapshot into the node's learned state.
 *
 * An eviction event is a model that vanished before its expiry together with a
 * new model appearing since the previous snapshot. If that combined size had
 * already fitted before, memory cannot be the reason: Ollama's loaded-model
 * limit forced it (→ maxLoaded). Below the limit, only memory explains it
 * (→ noFitBytes). At the limit both could, so nothing is learned. A vanish
 * without a new model is an explicit unload or expiry and teaches nothing.
 */
export function observeLoadedSnapshot(
  memory: NodeMemoryLearning,
  models: readonly LoadedModel[],
  now: number = Date.now(),
): void {
  const previous = memory.lastSnapshot
  if (previous) {
    const names = new Set(models.map((m) => m.name))
    const previousNames = new Set(previous.map((m) => m.name))
    const vanishedEarly = previous.some((m) => !names.has(m.name) && m.expiresAt > now)
    const appeared = models.filter((m) => !previousNames.has(m.name))
    if (vanishedEarly && appeared.length > 0) {
      const needed = sum(previous, (m) => m.size) + sum(appeared, (m) => m.size)
      if (needed <= memory.fitBytes) memory.maxLoaded = previous.length
      else if (previous.length < effectiveLoadedLimit(memory)) learnNoFit(memory, needed)
    }
  }

  const partialOffload = models.some((m) => m.sizeVram > 0 && m.sizeVram < m.size)
  if (partialOffload) {
    // Part of a model sits in CPU memory, so the GPU is full; Σ size would overstate what fits.
    learnNoFit(memory, sum(models, (m) => m.sizeVram))
  } else {
    memory.fitBytes = Math.max(memory.fitBytes, sum(models, (m) => m.size))
    // A total believed not to fit just did (misread event, or the node gained memory): forget it.
    if (memory.noFitBytes > 0 && memory.fitBytes >= memory.noFitBytes) memory.noFitBytes = 0
  }
  memory.maxSeenLoaded = Math.max(memory.maxSeenLoaded, models.length)
  memory.lastSnapshot = [...models]
}

function learnNoFit(memory: NodeMemoryLearning, bytes: number): void {
  if (!(bytes > 0)) return
  memory.noFitBytes = memory.noFitBytes > 0 ? Math.min(memory.noFitBytes, bytes) : bytes
}

/** Configured capacity wins; otherwise the learned "did not fit" total; otherwise unknown. */
export function resolveNodeMemory(
  memory: NodeMemoryLearning,
  configuredBytes: number | null,
): { bytes: number | null; source: MemorySource | null } {
  if (configuredBytes !== null) return { bytes: configuredBytes, source: 'config' }
  if (memory.noFitBytes > 0) return { bytes: memory.noFitBytes, source: 'learned' }
  return { bytes: null, source: null }
}

/** Learned limit if known, else the Ollama default raised to the most models ever seen loaded together. */
export function effectiveLoadedLimit(memory: NodeMemoryLearning): number {
  const floor = memory.maxLoaded > 0 ? memory.maxLoaded : DEFAULT_MAX_LOADED_MODELS
  return Math.max(floor, memory.maxSeenLoaded)
}
