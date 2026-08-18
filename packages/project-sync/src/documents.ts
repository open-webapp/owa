/**
 * Document sync engine — version-directed (try-write-first).
 *
 * Implements decisions 19–22: port notesdiary's already-shipped algorithm
 * verbatim in semantics, generalized over SyncDocument.
 *
 * Per project: resolve folder, then per document:
 * 1. Resolve fileId (cached → use directly; unknown → list by name → create new)
 * 2. Read local content
 * 3. Loop, max 3 attempts: write
 *    - Success → break (pure push: no read, no merge, no writeLocal)
 *    - RemoteChangedError → read remote, merge, writeLocal, retry
 *    - Other error → rethrow immediately
 * 4. Rebuild merged from each fresh read; never accumulate across attempts
 * 5. Log the two RemoteChangedError reasons distinguishably
 *
 * Payloads stay opaque end to end (string | Uint8Array).
 */

import type { FilesHandle, Logger, RemoteChangedError as DriveRemoteChangedError } from '@open-webapp/drive-sync';
import { RemoteChangedError, NotFoundError } from '@open-webapp/drive-sync';
import type { Project, SyncDocument, Payload } from './types.js';

/**
 * Result of syncing a single document.
 */
export interface SyncDocumentResult {
  key: string;
  success: boolean;
  driveFileId: string | null;
  error?: Error;
  /**
   * Conflicts from merge (if any).
   * Surfaced in sync status but never auto-resolved by the package.
   */
  conflicts?: unknown[];
  /**
   * Number of write attempts made (1 for pure push, 2+ if retried).
   */
  writeAttempts?: number;
  /**
   * Number of read attempts made (0 for pure push, 1+ if retried).
   */
  readAttempts?: number;
}

/**
 * Options for syncing documents in a project.
 */
export interface SyncDocumentsOptions {
  /**
   * Project being synced.
   */
  project: Project;

  /**
   * Drive folder id for this project (resolved by caller).
   */
  projectFolderId: string;

  /**
   * Function to get the current set of documents to sync.
   * Called fresh each sync, allowing the set to be dynamic.
   */
  documents: (project: Project) => SyncDocument[];

  /**
   * Drive files handle (from drive-sync's ProjectHandle).
   */
  files: FilesHandle;

  /**
   * Per-document sync state accessor and mutator.
   * Called by the engine to get cached fileId and to update state on success.
   */
  syncState: {
    /**
     * Get cached file id for a document key.
     * Returns null if never synced before.
     */
    getFileId(docKey: string): string | null;

    /**
     * Update sync state after a successful sync.
     * Called atomically to persist driveFileId and status.
     */
    update(docKey: string, fileId: string, conflicts?: unknown[]): Promise<void>;
  };

  /**
   * Optional logger for debugging.
   */
  logger?: Logger;
}

/**
 * Resolve a document's file ID.
 *
 * Flow:
 * 1. If cached fileId exists, use it directly (decision 24)
 * 2. Else list files by name in the project folder
 * 3. If found by name, use that ID (self-heal: persist the id)
 * 4. Else return null (creation happens in the write loop)
 *
 * @returns fileId to use, or null if not found (creation will happen)
 * @throws On list errors
 */
async function resolveFileId(
  doc: SyncDocument,
  docKey: string,
  projectFolderId: string,
  files: FilesHandle,
  cachedFileId: string | null,
  logger?: Logger
): Promise<string | null> {
  // Use cached ID directly (decision 24)
  if (cachedFileId) {
    logger?.log?.('debug', `Using cached fileId for document "${docKey}"`, {
      fileId: cachedFileId,
    });
    return cachedFileId;
  }

  // Unknown ID — try to find it by name (self-heal)
  logger?.log?.('debug', `No cached fileId for document "${docKey}", attempting name lookup`, {
    name: doc.name,
  });

  try {
    const found = await files.list({
      folderId: projectFolderId,
      nameEquals: doc.name,
    });

    if (found.length > 0) {
      // Use the first match (should be unique by name in the project folder)
      const fileId = found[0].id;
      logger?.log?.(
        'debug',
        `Self-healed fileId for document "${docKey}" via name lookup`,
        { fileId, name: doc.name }
      );
      return fileId;
    }
  } catch (err) {
    // List failed — log and fall through to creation
    logger?.log?.('warn', `Failed to list files for document "${docKey}": ${err}`, {
      docKey,
      name: doc.name,
    });
  }

  // Not found by name — will create in write loop
  logger?.log?.('debug', `File not found for document "${docKey}", will create on first write`, {
    name: doc.name,
  });
  return null;
}

/**
 * Sync a single document using the try-write-first (version-directed) algorithm.
 *
 * Per document:
 * 1. Resolve fileId (cached → list by name → create)
 * 2. Read local content
 * 3. Loop, max 3 attempts:
 *    - Write to Drive
 *    - Success → break (pure push)
 *    - RemoteChangedError → read remote, merge, writeLocal, retry
 *    - Other error → rethrow immediately
 *
 * @returns SyncDocumentResult with success flag, fileId, and any errors
 */
async function syncDocument(
  doc: SyncDocument,
  docKey: string,
  projectFolderId: string,
  files: FilesHandle,
  syncState: SyncDocumentsOptions['syncState'],
  logger?: Logger
): Promise<SyncDocumentResult> {
  const result: SyncDocumentResult = {
    key: docKey,
    success: false,
    driveFileId: null,
  };

  // Track reads and writes
  let readAttempts = 0;
  let writeAttempts = 0;

  try {
    // Step 1: Resolve fileId
    const cachedFileId = syncState.getFileId(docKey);
    let fileId = await resolveFileId(doc, docKey, projectFolderId, files, cachedFileId, logger);

    // fileId might be null if not cached and not found by name — will create on first write

    // Step 2: Read local content
    let content = await doc.readLocal();

    // Step 3: Loop, max 3 attempts
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      writeAttempts = attempt;
      result.writeAttempts = writeAttempts;
      // readAttempts is tracked separately and only incremented on actual reads

      try {
        // If fileId is null, this is the first write and we need to create the file
        if (!fileId) {
          logger?.log?.('debug', `Creating file for document "${docKey}" on first write`, {
            name: doc.name,
            contentLength: content?.length ?? 0,
          });

          const ref = await files.write({
            folderId: projectFolderId,
            name: doc.name,
            content: content ?? '',
            mimeType: doc.mimeType,
            // Deliberately NO fileId: this is a new file
          });

          fileId = ref.id;
          result.driveFileId = fileId;

          logger?.log?.('debug', `Created file for document "${docKey}"`, {
            fileId,
            name: ref.name,
          });

          // Update sync state after creation
          await syncState.update(docKey, fileId);

          result.success = true;
          result.readAttempts = readAttempts;
          return result;
        }

        // fileId exists — attempt write
        result.driveFileId = fileId;
        logger?.log?.('debug', `Syncing document "${docKey}" (attempt ${attempt}/${MAX_ATTEMPTS})`, {
          fileId,
          contentLength: content?.length ?? 0,
        });

        await files.write({
          fileId,
          content: content ?? '',
          mimeType: doc.mimeType,
          // Deliberately NO folderId/name: we have the fileId from step 1
        });

        // Success! Pure push complete
        logger?.log?.(
          'debug',
          `Successfully synced document "${docKey}" (pure push, attempt ${attempt})`,
          {
            fileId,
            writeAttempts: attempt,
            readAttempts: 0,
          }
        );

        // Update sync state (pass conflicts if any)
        await syncState.update(docKey, fileId, result.conflicts);

        result.success = true;
        result.readAttempts = readAttempts;
        return result;
      } catch (err) {
        // Check if this is a RemoteChangedError
        if (!(err instanceof RemoteChangedError)) {
          // Non-RemoteChangedError: rethrow immediately (decision 21)
          logger?.log?.(
            'error',
            `Failed to sync document "${docKey}" with non-retryable error: ${err}`,
            { docKey, attempt, fileId }
          );
          throw err;
        }

        // RemoteChangedError: check if we can retry
        const remoteErr = err as DriveRemoteChangedError;
        if (attempt === MAX_ATTEMPTS) {
          // Attempt 3: exhausted
          logger?.log?.(
            'error',
            `Sync conflict exhausted for document "${docKey}" after ${MAX_ATTEMPTS} attempts`,
            {
              docKey,
              fileId,
              reason: remoteErr.reason,
            }
          );
          throw new Error(`Sync conflict could not be resolved`);
        }

        // Log the conflict reason distinguishably
        logger?.log?.(
          'debug',
          `Conflict detected for document "${docKey}": ${remoteErr.reason === 'never-restored' ? 'first sync against pre-existing file' : 'remote content changed'}`,
          {
            docKey,
            fileId,
            attempt,
            reason: remoteErr.reason,
          }
        );

        // Read remote, merge, writeLocal, retry
        logger?.log?.('debug', `Reading remote content for document "${docKey}"`, {
          fileId,
          attempt,
        });

        readAttempts++;
        result.readAttempts = readAttempts;
        const remote = await files.read(fileId);

        logger?.log?.('debug', `Merging remote content for document "${docKey}"`, {
          fileId,
          attempt,
          remoteLength: remote?.length ?? 0,
        });

        // Merge: rebuild from fresh read, never accumulate (decision 22)
        const local = await doc.readLocal();
        const { merged, conflicts } = await doc.merge(local, remote);

        if (conflicts && conflicts.length > 0) {
          result.conflicts = conflicts;
          logger?.log?.('debug', `Merge produced conflicts for document "${docKey}"`, {
            docKey,
            conflictCount: conflicts.length,
          });
        } else {
          // Clear conflicts if merge produced none (rebuilding from fresh read)
          result.conflicts = undefined;
        }

        // Write merged back locally
        logger?.log?.('debug', `Writing merged content locally for document "${docKey}"`, {
          docKey,
          attempt,
        });
        await doc.writeLocal(merged);

        // Update content for next iteration
        content = merged;

        // After successful merge and writeLocal, try to write again
        // The next iteration will attempt the write with the merged content

        // Loop back to retry the write
        logger?.log?.('debug', `Retrying write for document "${docKey}"`, {
          docKey,
          fileId,
          attempt,
          nextAttempt: attempt + 1,
        });
      }
    }

    // Should never reach here (loop breaks or throws)
    throw new Error(`Unexpected state in sync loop for document "${docKey}"`);
  } catch (error) {
    result.error = error instanceof Error ? error : new Error(String(error));
    result.readAttempts = readAttempts;
    logger?.log?.('error', `Sync failed for document "${docKey}": ${result.error.message}`, {
      docKey,
      error: result.error,
    });
    return result;
  }
}

/**
 * Sync all documents for a project.
 *
 * Called fresh on every sync with the current set of documents.
 * Syncs continue even if individual documents fail.
 *
 * @returns Array of sync results, one per document
 */
export async function syncDocuments(opts: SyncDocumentsOptions): Promise<SyncDocumentResult[]> {
  const { project, projectFolderId, documents, files, syncState, logger } = opts;

  logger?.log?.('debug', `Starting sync for project "${project.name}"`, {
    projectId: project.id,
    projectFolderId,
  });

  // Get the current set of documents (dynamic, per decision 9)
  const docs = documents(project);
  logger?.log?.(
    'debug',
    `Found ${docs.length} document(s) to sync in project "${project.name}"`,
    { projectId: project.id }
  );

  // Sync each document (continue even if individual ones fail)
  const results: SyncDocumentResult[] = [];
  for (const doc of docs) {
    const docKey = doc.key;
    try {
      const result = await syncDocument(
        doc,
        docKey,
        projectFolderId,
        files,
        syncState,
        logger
      );
      results.push(result);
    } catch (err) {
      // This shouldn't happen as syncDocument handles errors, but be defensive
      logger?.log?.(
        'error',
        `Unexpected error syncing document "${docKey}": ${err}`,
        { docKey }
      );
      results.push({
        key: docKey,
        success: false,
        driveFileId: null,
        error: err instanceof Error ? err : new Error(String(err)),
        writeAttempts: 0,
        readAttempts: 0,
      });
    }
  }

  const successCount = results.filter((r) => r.success).length;
  logger?.log?.('debug', `Sync completed for project "${project.name}"`, {
    projectId: project.id,
    totalDocuments: results.length,
    successful: successCount,
  });

  return results;
}
