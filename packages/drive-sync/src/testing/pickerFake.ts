/**
 * A scriptable double for Google Picker (google.picker),
 * for use in tests of code that calls `window.google.picker.PickerBuilder`
 * and related APIs.
 *
 * Usage:
 *
 * ```ts
 * const pickerFake = createPickerFake()
 * pickerFake.install()
 * // ... exercise code under test that calls openPicker() ...
 * pickerFake.simulatePick([{ fileId: '123', name: 'doc.txt', mimeType: 'text/plain' }])
 * await expect(openPickerPromise).resolves.toEqual([...])
 * expect(pickerFake.calls).toHaveLength(1)
 * ```
 */

export interface PickerFakeFile {
  fileId: string
  name: string
  mimeType: string
}

export interface PickerRecordedCall {
  oauthToken?: string
  developerKey?: string
  views: Array<{
    mimeTypes?: string
    parentId?: string
  }>
  features: string[]
}

export interface PickerFake {
  /** All PickerBuilder constructions and their configurations, in order. */
  calls: PickerRecordedCall[]
  /** Simulate user picking files; invokes the picker's callback asynchronously. */
  simulatePick(files: PickerFakeFile[]): void
  /** Simulate user cancelling; invokes the picker's callback asynchronously. */
  simulateCancel(): void
  /** Stub window.gapi and window.google.picker with this fake. */
  install(): void
  /** Remove the stub installed by `install()`, restoring prior state. */
  uninstall(): void
  /** Clear call history and stored callback state. */
  reset(): void
}

export function createPickerFake(): PickerFake {
  const calls: PickerRecordedCall[] = []
  let storedCallback: ((data: any) => void) | null = null
  let previousGapi: unknown
  let hadGapi = false
  let previousGoogle: unknown
  let hadGoogle = false
  let previousGooglePicker: unknown
  let hadGooglePicker = false

  /**
   * Fake DocsView class for stubbing window.google.picker.DocsView.
   * Stores MIME types and parent folder ID, and is chainable.
   */
  class FakeDocsView {
    mimeTypes?: string
    parentId?: string

    setMimeTypes(types: string): FakeDocsView {
      this.mimeTypes = types
      return this
    }

    setParent(folderId: string): FakeDocsView {
      this.parentId = folderId
      return this
    }
  }

  /**
   * Fake PickerInstance (returned by PickerBuilder.build()).
   * When setVisible(true) is called, it's recorded but callback is not fired
   * until simulatePick or simulateCancel is called.
   */
  class FakePickerInstance {
    setVisible(visible: boolean): void {
      // Visibility change is recorded implicitly by the builder construction.
      // The callback will be triggered by simulatePick/simulateCancel.
    }
  }

  /**
   * Fake PickerBuilder class for stubbing window.google.picker.PickerBuilder.
   * Chainable methods all return `this`, and build() returns a FakePickerInstance.
   */
  class FakePickerBuilder {
    private currentCall: PickerRecordedCall = {
      views: [],
      features: [],
    }

    addView(view: FakeDocsView): FakePickerBuilder {
      this.currentCall.views.push({
        mimeTypes: view.mimeTypes,
        parentId: view.parentId,
      })
      return this
    }

    setOAuthToken(token: string): FakePickerBuilder {
      this.currentCall.oauthToken = token
      return this
    }

    setDeveloperKey(key: string): FakePickerBuilder {
      this.currentCall.developerKey = key
      return this
    }

    enableFeature(feature: string): FakePickerBuilder {
      this.currentCall.features.push(feature)
      return this
    }

    setCallback(callback: (data: any) => void): FakePickerBuilder {
      storedCallback = callback
      return this
    }

    build(): FakePickerInstance {
      // Record the call once build() is invoked (not before, so all config is captured)
      calls.push(this.currentCall)
      return new FakePickerInstance()
    }
  }

  return {
    calls,
    simulatePick(files: PickerFakeFile[]): void {
      if (!storedCallback) {
        return
      }
      const callback = storedCallback
      queueMicrotask(() => {
        callback({
          action: 'picked',
          docs: files.map((file) => ({
            id: file.fileId,
            name: file.name,
            mimeType: file.mimeType,
          })),
        })
      })
    },
    simulateCancel(): void {
      if (!storedCallback) {
        return
      }
      const callback = storedCallback
      queueMicrotask(() => {
        callback({
          action: 'cancel',
        })
      })
    },
    install() {
      const w = globalThis as unknown as { gapi?: any; google?: any }

      // Save and replace window.gapi
      hadGapi = Object.prototype.hasOwnProperty.call(w, 'gapi')
      previousGapi = w.gapi
      w.gapi = {
        load(api: string, callback: () => void): void {
          if (api === 'picker') {
            queueMicrotask(callback)
          }
        },
      }

      // Save and replace window.google
      hadGoogle = Object.prototype.hasOwnProperty.call(w, 'google')
      previousGoogle = w.google

      if (!w.google) {
        w.google = {}
      }

      // Save and replace window.google.picker
      hadGooglePicker = Object.prototype.hasOwnProperty.call(w.google, 'picker')
      previousGooglePicker = w.google.picker

      w.google.picker = {
        PickerBuilder: FakePickerBuilder,
        DocsView: FakeDocsView,
        Action: {
          PICKED: 'picked',
          CANCEL: 'cancel',
        },
        ViewId: {
          DOCS: 'docs',
        },
        Feature: {
          MULTISELECT_ENABLED: 'multiselect',
        },
      }
    },
    uninstall() {
      const w = globalThis as unknown as { gapi?: any; google?: any }

      // Restore window.gapi
      if (hadGapi) {
        w.gapi = previousGapi
      } else {
        delete w.gapi
      }

      // Restore window.google.picker
      if (hadGooglePicker) {
        w.google!.picker = previousGooglePicker
      } else if (w.google) {
        delete w.google.picker
      }

      // Restore window.google (if it was only created by install())
      if (!hadGoogle) {
        delete w.google
      } else {
        w.google = previousGoogle
      }
    },
    reset() {
      calls.length = 0
      storedCallback = null
    },
  }
}
