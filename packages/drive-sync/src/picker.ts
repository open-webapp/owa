import type { WorkspaceMimeShorthand } from './types.js';
import { PickerCancelledError } from './errors.js';

/**
 * Minimal ambient type declarations for Google Picker and GIS APIs.
 * These allow TypeScript to recognize window.gapi and window.google.picker
 * without importing the actual Google libraries.
 */

declare global {
  interface Window {
    gapi?: {
      load(api: string, callback: () => void): void;
    };
    google?: {
      picker?: {
        PickerBuilder: new (...args: any[]) => PickerBuilder;
        DocsView: new (...args: any[]) => DocsView;
        Action: {
          PICKED: string;
          CANCEL: string;
        };
        ViewId: {
          DOCS: string;
        };
        Feature: {
          MULTISELECT_ENABLED: string;
        };
      };
    };
  }
}

interface PickerBuilder {
  addView(view: DocsView): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  enableFeature(feature: string): PickerBuilder;
  setCallback(callback: (data: PickerResponse) => void): PickerBuilder;
  build(): PickerInstance;
}

interface DocsView {
  setMimeTypes(types: string): DocsView;
  setParent(folderId: string): DocsView;
}

interface PickerInstance {
  setVisible(visible: boolean): void;
}

interface PickerResponse {
  action?: string;
  docs?: PickerDocument[];
}

interface PickerDocument {
  id: string;
  name: string;
  mimeType: string;
}

/**
 * Maps Google Workspace document type shorthands to their full MIME types.
 */
const WORKSPACE_MIME_SHORTHAND: Record<WorkspaceMimeShorthand, string> = {
  docs: 'application/vnd.google-apps.document',
  sheets: 'application/vnd.google-apps.spreadsheet',
  slides: 'application/vnd.google-apps.presentation',
  forms: 'application/vnd.google-apps.form',
  drawings: 'application/vnd.google-apps.drawing',
};

/**
 * Module-level cache for the Picker script loading promise.
 * Reused across multiple openPicker() calls to avoid re-injecting the script.
 */
let scriptLoadPromise: Promise<void> | null = null;

/**
 * Resolves an optional array of MIME types, expanding shorthand tokens
 * (e.g., 'docs', 'sheets') to their full `application/vnd.google-apps.*` equivalents
 * and passing literal MIME strings through unchanged.
 *
 * @param mimeTypes - Array containing strings and/or WorkspaceMimeShorthand tokens
 * @returns Expanded array of MIME type strings, or undefined if input is undefined
 */
function resolveMimeTypes(
  mimeTypes?: (string | WorkspaceMimeShorthand)[]
): string[] | undefined {
  if (!mimeTypes) {
    return undefined;
  }

  return mimeTypes.map((type) => {
    if (type in WORKSPACE_MIME_SHORTHAND) {
      return WORKSPACE_MIME_SHORTHAND[type as WorkspaceMimeShorthand];
    }
    return type;
  });
}

/**
 * Ensures the Google Picker API is loaded by:
 * 1. Checking if window.google.picker already exists (e.g., from a test fake)
 * 2. Reusing a pending script load if one is already in progress
 * 3. Otherwise, injecting the picker script and waiting for gapi.load('picker')
 *
 * On script error, resets the cache so a retry will re-inject.
 *
 * @throws Error if script load fails
 */
async function ensurePickerLoaded(): Promise<void> {
  // Already loaded (e.g., by a test fake or prior successful load)
  if (window.google?.picker) {
    return;
  }

  // Script load already in progress; reuse the existing promise
  if (scriptLoadPromise) {
    return scriptLoadPromise;
  }

  // Inject the Picker script and set up the load promise
  scriptLoadPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js';

    script.onload = () => {
      // Script loaded; now request the Picker API
      window.gapi!.load('picker', () => {
        resolve();
      });
    };

    script.onerror = () => {
      // Script failed to load; reset cache so retry can re-inject
      scriptLoadPromise = null;
      reject(new Error('Failed to load Google Picker script'));
    };

    document.head.appendChild(script);
  });

  return scriptLoadPromise;
}

/**
 * Test-only export: resets the script load cache, allowing tests to
 * re-inject or mock the picker script. Exported normally (not conditionally gated)
 * so tests can import and call it directly.
 */
export function __resetPickerScriptCacheForTests(): void {
  scriptLoadPromise = null;
}

export interface OpenPickerOptions {
  apiKey: string;
  oauthToken: string;
  mimeTypes?: (string | WorkspaceMimeShorthand)[];
  multiSelect?: boolean;
  parentFolderId?: string;
}

export interface PickedFile {
  fileId: string;
  name: string;
  mimeType: string;
}

/**
 * Opens the Google Picker dialog for file selection, returning a promise
 * that resolves with the selected files or rejects if the user cancels.
 *
 * The picker is configured with optional MIME type filters, multi-select
 * support, and a parent folder constraint.
 *
 * @param opts - Configuration including API key, OAuth token, and picker options
 * @returns Promise resolving to an array of picked files
 * @throws PickerCancelledError if the user cancels the dialog
 * @throws Error if the Picker script fails to load or configuration fails
 */
export async function openPicker(opts: OpenPickerOptions): Promise<PickedFile[]> {
  // Ensure the Picker API is available
  await ensurePickerLoaded();

  // Create and configure a DocsView for file browsing
  const docsView = new window.google!.picker!.DocsView();

  // Apply MIME type filters if provided
  const resolvedMimes = resolveMimeTypes(opts.mimeTypes);
  if (resolvedMimes) {
    docsView.setMimeTypes(resolvedMimes.join(','));
  }

  // Constrain to a specific parent folder if provided
  if (opts.parentFolderId) {
    docsView.setParent(opts.parentFolderId);
  }

  // Create and configure the PickerBuilder
  const pickerBuilder = new window.google!.picker!.PickerBuilder();
  pickerBuilder
    .addView(docsView)
    .setOAuthToken(opts.oauthToken)
    .setDeveloperKey(opts.apiKey);

  // Enable multi-select if requested
  if (opts.multiSelect) {
    pickerBuilder.enableFeature(window.google!.picker!.Feature.MULTISELECT_ENABLED);
  }

  // Set up the response handler and build the picker
  return new Promise<PickedFile[]>((resolve, reject) => {
    pickerBuilder.setCallback((data: PickerResponse) => {
      // User picked files
      if (data.action === window.google!.picker!.Action.PICKED && data.docs) {
        const picked = data.docs.map((doc) => ({
          fileId: doc.id,
          name: doc.name,
          mimeType: doc.mimeType,
        }));
        resolve(picked);
        return;
      }

      // User cancelled
      if (data.action === window.google!.picker!.Action.CANCEL) {
        reject(new PickerCancelledError());
        return;
      }
    });

    pickerBuilder.build().setVisible(true);
  });
}
