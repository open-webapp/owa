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

/**
 * Response delivered to an `initCodeClient` callback — the auth-code
 * (server-side / PKCE) flow. Mirrors the shape the real GIS code client
 * passes: `{ code }` on success, `{ error }` on an in-band failure.
 */
export interface GisCodeResponse {
  code?: string
  error?: string
}

export interface GisCodeRecordedCall {
  scope: string
  hint?: string
}

export interface GisCodeClientConfig {
  client_id?: string
  scope?: string
  hint?: string
  ux_mode?: string
  redirect_uri?: string
  callback?: (response: GisCodeResponse) => void
  error_callback?: (error: { type?: string; message?: string }) => void
  [key: string]: unknown
}

export interface GisCodeClient {
  requestCode(): void
}

export interface GisFake {
  /** All calls made via `requestAccessToken`, in order. */
  calls: GisRecordedCall[]
  /** All calls made via the code client's `requestCode`, in order. */
  codeCalls: GisCodeRecordedCall[]
  /** Queue a response to be delivered to the next `requestAccessToken` call. */
  queueResponse(response: GisTokenResponse): void
  /**
   * Queue a response for the next code-client `requestCode()` call, delivered
   * via `callback` — `{ code }` on success or `{ error }` for an in-band
   * failure. With nothing queued, `requestCode()` yields `{ code: 'fake-auth-code' }`.
   */
  queueCodeResponse(response: GisCodeResponse): void
  /**
   * Queue a popup-level failure for the next `requestCode()` call, delivered
   * via `error_callback` (e.g. `'popup_closed'`) — the channel the real GIS
   * code client uses for a blocked/dismissed popup, which never reaches
   * `callback`.
   */
  queueCodeError(type: string): void
  /**
   * Queue a popup-level failure for the next `requestAccessToken` call,
   * delivered via `error_callback` — the channel the real GIS client uses
   * for a blocked or dismissed popup, which never reaches `callback`.
   */
  queuePopupError(type: string): void
  /**
   * Queue a `popup_closed` error_callback that is followed, after `delayMs`,
   * by a successful token `callback` — reproducing the real GIS race where
   * the popup-closed poll fires before the success message is delivered.
   */
  queuePopupClosedRace(response: GisTokenResponse, delayMs: number): void
  /**
   * Queue a request that GIS never answers at all: neither `callback` nor
   * `error_callback` is ever invoked. This is the real-world shape of a flow
   * whose result is never posted back to the page (e.g. a silent
   * `prompt: 'none'` request in a browser that blocks silent token issuance).
   */
  queueSilence(): void
  /** Stub `window.google.accounts.oauth2.initTokenClient` with this fake. */
  install(): void
  /** Remove the stub installed by `install()`, restoring prior state. */
  uninstall(): void
  /** Clear queued responses and call history. */
  reset(): void
}

interface PopupClosedRace {
  response: GisTokenResponse
  delayMs: number
}

export function createGisFake(): GisFake {
  const responseQueue: GisTokenResponse[] = []
  const popupErrorQueue: (string | undefined)[] = []
  const popupClosedRaceQueue: PopupClosedRace[] = []
  let silenceQueue = 0
  const calls: GisRecordedCall[] = []
  const codeResponseQueue: GisCodeResponse[] = []
  const codeErrorQueue: (string | undefined)[] = []
  const codeCalls: GisCodeRecordedCall[] = []
  let previousGoogle: unknown
  let hadGoogle = false

  function nextResponse(): GisTokenResponse {
    const next = responseQueue.shift()
    if (next) return next
    // Default: a generic successful token response.
    return { access_token: 'fake-access-token', expires_in: 3600, scope: '' }
  }

  function nextCodeResponse(): GisCodeResponse {
    const next = codeResponseQueue.shift()
    if (next) return next
    // Default: a generic successful auth-code response.
    return { code: 'fake-auth-code' }
  }

  function initCodeClient(config: GisCodeClientConfig): GisCodeClient {
    return {
      requestCode() {
        const hint = config.hint
        const scope = config.scope ?? ''

        codeCalls.push({ scope, hint })

        if (silenceQueue > 0) {
          silenceQueue -= 1
          return
        }

        const codeError = codeErrorQueue.shift()
        if (codeError) {
          const errorCallback = config.error_callback
          queueMicrotask(() => {
            errorCallback?.({ type: codeError })
          })
          return
        }

        const response = nextCodeResponse()
        const callback = config.callback

        // Deliver asynchronously (microtask), matching the real GIS code
        // client's callback-based, non-synchronous delivery.
        queueMicrotask(() => {
          if (response.error) {
            callback?.({ error: response.error })
            return
          }
          callback?.(response)
        })
      },
    }
  }

  function initTokenClient(config: GisTokenClientConfig): GisTokenClient {
    return {
      requestAccessToken(overrideConfig?: GisRequestAccessTokenOverride) {
        const prompt = overrideConfig?.prompt ?? config.prompt ?? 'consent'
        const hint = overrideConfig?.hint ?? config.hint
        const scope = overrideConfig?.scope ?? config.scope ?? ''

        calls.push({ prompt, hint, scope })

        if (silenceQueue > 0) {
          silenceQueue -= 1
          return
        }

        const popupClosedRace = popupClosedRaceQueue.shift()
        if (popupClosedRace) {
          const errorCallback = config.error_callback
          const callback = config.callback
          queueMicrotask(() => {
            errorCallback?.({ type: 'popup_closed' })
          })
          setTimeout(() => {
            callback?.(popupClosedRace.response)
          }, popupClosedRace.delayMs)
          return
        }

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
    codeCalls,
    queueResponse(response: GisTokenResponse) {
      responseQueue.push(response)
    },
    queueCodeResponse(response: GisCodeResponse) {
      codeResponseQueue.push(response)
    },
    queueCodeError(type: string) {
      codeErrorQueue.push(type)
    },
    queuePopupError(type: string) {
      popupErrorQueue.push(type)
    },
    queuePopupClosedRace(response: GisTokenResponse, delayMs: number) {
      popupClosedRaceQueue.push({ response, delayMs })
    },
    queueSilence() {
      silenceQueue += 1
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
      w.google.accounts.oauth2.initCodeClient = initCodeClient
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
      popupClosedRaceQueue.length = 0
      silenceQueue = 0
      calls.length = 0
      codeResponseQueue.length = 0
      codeErrorQueue.length = 0
      codeCalls.length = 0
    },
  }
}
