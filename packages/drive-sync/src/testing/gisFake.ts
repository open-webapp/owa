/**
 * A scriptable double for Google Identity Services (GIS) token client,
 * for use in tests of code that calls
 * `window.google.accounts.oauth2.initTokenClient(...)`.
 *
 * Usage:
 *
 * ```ts
 * const gisFake = createGisFake()
 * gisFake.install()
 * gisFake.queueResponse({ access_token: 'tok', expires_in: 3600, scope: 'a b' })
 * // ... exercise code under test ...
 * expect(gisFake.calls).toEqual([{ prompt: 'consent', hint: undefined, scope: 'a b' }])
 * ```
 */

export interface GisTokenResponse {
  access_token?: string
  expires_in?: number
  scope?: string
  error?: string
}

export interface GisRecordedCall {
  prompt: string
  hint?: string
  scope: string
}

export interface GisTokenClientConfig {
  client_id?: string
  scope?: string
  prompt?: string
  hint?: string
  callback?: (response: GisTokenResponse) => void
  error_callback?: (error: { type?: string; message?: string }) => void
  [key: string]: unknown
}

export interface GisRequestAccessTokenOverride {
  prompt?: string
  hint?: string
  scope?: string
  [key: string]: unknown
}

export interface GisTokenClient {
  requestAccessToken(overrideConfig?: GisRequestAccessTokenOverride): void
}

export interface GisFake {
  /** All calls made via `requestAccessToken`, in order. */
  calls: GisRecordedCall[]
  /** Queue a response to be delivered to the next `requestAccessToken` call. */
  queueResponse(response: GisTokenResponse): void
  /**
   * Queue a popup-level failure for the next `requestAccessToken` call,
   * delivered via `error_callback` — the channel the real GIS client uses
   * for a blocked or dismissed popup, which never reaches `callback`.
   */
  queuePopupError(type: string): void
  /** Stub `window.google.accounts.oauth2.initTokenClient` with this fake. */
  install(): void
  /** Remove the stub installed by `install()`, restoring prior state. */
  uninstall(): void
  /** Clear queued responses and call history. */
  reset(): void
}

export function createGisFake(): GisFake {
  const responseQueue: GisTokenResponse[] = []
  const popupErrorQueue: (string | undefined)[] = []
  const calls: GisRecordedCall[] = []
  let previousGoogle: unknown
  let hadGoogle = false

  function nextResponse(): GisTokenResponse {
    const next = responseQueue.shift()
    if (next) return next
    // Default: a generic successful token response.
    return { access_token: 'fake-access-token', expires_in: 3600, scope: '' }
  }

  function initTokenClient(config: GisTokenClientConfig): GisTokenClient {
    return {
      requestAccessToken(overrideConfig?: GisRequestAccessTokenOverride) {
        const prompt = overrideConfig?.prompt ?? config.prompt ?? 'consent'
        const hint = overrideConfig?.hint ?? config.hint
        const scope = overrideConfig?.scope ?? config.scope ?? ''

        calls.push({ prompt, hint, scope })

        const popupError = popupErrorQueue.shift()
        if (popupError) {
          const errorCallback = config.error_callback
          queueMicrotask(() => {
            errorCallback?.({ type: popupError })
          })
          return
        }

        const response = nextResponse()
        const callback = config.callback

        // Deliver asynchronously (microtask), matching the real GIS client's
        // callback-based, non-synchronous delivery.
        queueMicrotask(() => {
          if (response.error) {
            // The real GIS client invokes the token callback with an object
            // containing an `error` field (e.g. `{ error: 'access_denied' }`)
            // rather than throwing or rejecting a promise.
            callback?.({ error: response.error })
            return
          }
          callback?.(response)
        })
      },
    }
  }

  return {
    calls,
    queueResponse(response: GisTokenResponse) {
      responseQueue.push(response)
    },
    queuePopupError(type: string) {
      popupErrorQueue.push(type)
    },
    install() {
      const w = globalThis as unknown as { google?: any }
      hadGoogle = Object.prototype.hasOwnProperty.call(w, 'google')
      previousGoogle = w.google

      if (!w.google) {
        w.google = {}
      }
      if (!w.google.accounts) {
        w.google.accounts = {}
      }
      if (!w.google.accounts.oauth2) {
        w.google.accounts.oauth2 = {}
      }
      w.google.accounts.oauth2.initTokenClient = initTokenClient
    },
    uninstall() {
      const w = globalThis as unknown as { google?: any }
      if (hadGoogle) {
        w.google = previousGoogle
      } else {
        delete w.google
      }
    },
    reset() {
      responseQueue.length = 0
      popupErrorQueue.length = 0
      calls.length = 0
    },
  }
}
