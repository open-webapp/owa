import { describe, expect, it } from 'vitest'
import { createDriveFake, createGisFake, createPickerFake } from '../testing/index.js'

describe('testing subpath exports', () => {
  it('createGisFake returns an object with the expected methods', () => {
    const gisFake = createGisFake()
    expect(gisFake).toBeDefined()
    expect(gisFake.calls).toBeDefined()
    expect(typeof gisFake.queueResponse).toBe('function')
    expect(typeof gisFake.install).toBe('function')
    expect(typeof gisFake.uninstall).toBe('function')
    expect(typeof gisFake.reset).toBe('function')
  })

  it('createDriveFake returns an object with the expected methods', () => {
    const driveFake = createDriveFake()
    expect(driveFake).toBeDefined()
    expect(typeof driveFake.fetch).toBe('function')
    expect(driveFake.folderCreationLog).toBeDefined()
    expect(typeof driveFake.setStatusOverride).toBe('function')
    expect(typeof driveFake.reset).toBe('function')
    expect(driveFake.files).toBeDefined()
    expect(driveFake.permissions).toBeDefined()
  })

  it('createPickerFake is exported and returns a function', () => {
    expect(typeof createPickerFake).toBe('function')
  })
})
