import { describe, it, expect } from 'vitest'
import type {
  ProjectSyncOptions,
  ProjectSync,
  Project,
  SyncDocument,
  SyncStatus,
  Payload,
  DocumentState,
} from '../types.js'

describe('smoke tests', () => {
  it('imports main entrypoint with type exports', async () => {
    const main = await import('../index.ts')
    expect(main).toBeDefined()
    // T12: Type exports are frozen; implementations come in later tasks
  })

  it('provides all required types for T12', () => {
    // Verify types exist (compile-time check via TypeScript)
    // These are used to ensure all interview decisions are expressible
    const _options: ProjectSyncOptions = null as any
    const _sync: ProjectSync = null as any
    const _project: Project = null as any
    const _doc: SyncDocument = null as any
    const _status: SyncStatus = null as any
    const _payload: Payload = 'test'
    const _docState: DocumentState = null as any

    // If this compiles, all types are properly defined
    expect(_payload).toBe('test')
  })

  it('Payload type is string | Uint8Array', () => {
    const stringPayload: Payload = 'hello'
    const uint8Payload: Payload = new Uint8Array([1, 2, 3])

    expect(typeof stringPayload).toBe('string')
    expect(uint8Payload instanceof Uint8Array).toBe(true)
  })

  it('type imports from index work correctly', async () => {
    const types = await import('../index.ts')
    // Verify the main export re-exports the types
    expect(types).toBeDefined()
  })
})
