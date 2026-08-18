/**
 * In-memory fake of Drive folder operations for testing.
 *
 * Composes with driveFake from drive-sync to provide a complete
 * fake folder resolution system that works entirely in-memory
 * without any network calls.
 *
 * Usage:
 * ```ts
 * const driveFake = createDriveFake()
 * const folderFake = createDriveFolderFake(driveFake)
 * const folderOps = folderFake.folderOperations()
 * // Use folderOps in resolveProjectFolder()
 * ```
 */

import type { DriveFake } from '@open-webapp/drive-sync/testing';
import type { FolderOperations } from '../folders.js';

const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

/**
 * Fake folder operations that compose with driveFake.
 */
export interface DriveFolderFake {
  /**
   * Get the FolderOperations interface for use with resolveProjectFolder.
   */
  folderOperations(): FolderOperations;

  /**
   * Inspect current in-memory folders (for testing).
   */
  readonly folders: Map<
    string,
    {
      id: string;
      name: string;
      parentId: string | undefined;
    }
  >;

  /**
   * Clear all folder state (but not the underlying driveFake).
   */
  reset(): void;
}

/**
 * Create an in-memory fake for folder operations.
 * Composes with a driveFake to store folders as files in the fake Drive.
 */
export function createDriveFolderFake(driveFake: DriveFake): DriveFolderFake {
  const folders = new Map<
    string,
    {
      id: string;
      name: string;
      parentId: string | undefined;
    }
  >();

  const folderOps: FolderOperations = {
    /**
     * List folders/files in a parent.
     */
    async list(opts: any): Promise<any[]> {
      const results: any[] = [];

      // Iterate through driveFake's files
      for (const file of driveFake.files.values()) {
        // Filter by parent ID if specified
        if (opts.folderId !== undefined && !file.parents.includes(opts.folderId)) {
          continue;
        }

        // Filter by MIME type if specified
        if (opts.mimeType !== undefined && file.mimeType !== opts.mimeType) {
          continue;
        }

        // Filter by name if specified
        if (opts.nameEquals !== undefined && file.name !== opts.nameEquals) {
          continue;
        }

        // Filter by trashed status
        if (file.trashed) {
          continue;
        }

        results.push({
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          parents: file.parents,
          createdTime: file.modifiedTime,
          modifiedTime: file.modifiedTime,
        });
      }

      return results;
    },

    /**
     * Get a single folder/file by ID.
     */
    async get(opts: any): Promise<any | null> {
      const file = driveFake.files.get(opts.fileId);

      if (!file || file.trashed) {
        return null;
      }

      return {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        parents: file.parents,
        trashed: file.trashed,
        createdTime: file.modifiedTime,
        modifiedTime: file.modifiedTime,
      };
    },

    /**
     * Create a new folder.
     */
    async createFolder(opts: any): Promise<string> {
      // Generate a folder ID
      const folderId = `folder-${Date.now()}-${Math.random().toString(36).substring(7)}`;

      // Create the folder in driveFake
      driveFake.files.set(folderId, {
        id: folderId,
        name: opts.name,
        mimeType: FOLDER_MIME_TYPE,
        parents: opts.parentId ? [opts.parentId] : [],
        content: '',
        version: 1,
        modifiedTime: new Date().toISOString(),
      });

      // Track in our folders index
      folders.set(folderId, {
        id: folderId,
        name: opts.name,
        parentId: opts.parentId,
      });

      return folderId;
    },

    /**
     * Update a folder (e.g., rename).
     */
    async update(opts: any): Promise<void> {
      const file = driveFake.files.get(opts.fileId);

      if (!file) {
        throw new Error(`Folder not found: ${opts.fileId}`);
      }

      // Update the name if provided
      if (opts.name !== undefined) {
        file.name = opts.name;
      }

      // Update other metadata if provided
      if (opts.mimeType !== undefined) {
        file.mimeType = opts.mimeType;
      }

      if (Array.isArray(opts.parents)) {
        file.parents = opts.parents;
      }

      file.version = (file.version ?? 1) + 1;

      // Update in our folders index
      const folderInfo = folders.get(opts.fileId);
      if (folderInfo && opts.name !== undefined) {
        folderInfo.name = opts.name;
      }
    },
  };

  return {
    folderOperations(): FolderOperations {
      return folderOps;
    },

    folders,

    reset(): void {
      folders.clear();
    },
  };
}
