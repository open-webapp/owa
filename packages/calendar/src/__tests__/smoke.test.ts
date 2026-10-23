import { describe, it, expect } from 'vitest'

describe('package', () => {
  it('resolves entry points', async () => {
    expect(await import('../index')).toBeDefined()
    expect(await import('../testing/index')).toBeDefined()
  })
})
