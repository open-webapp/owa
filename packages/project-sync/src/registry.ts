/**
 * Registry module for managing projects in IndexedDB.
 *
 * Provides CRUD operations for projects with:
 * - IDB `projects` store keyed by `id`
 * - `by-name-key` index over normalized (trimmed, lowercased) names
 * - `by-created` index for createdAt-based ordering
 * - Stable opaque ID generation
 * - Unique name enforcement (case-insensitive, trimmed)
 */

import type { IDBPDatabase } from 'idb';
import { openDB } from 'idb';
import type { Project } from './types.js';

/**
 * Normalized name for unique constraint checking.
 * Trim and lowercase to enforce case-insensitive uniqueness.
 */
function normalizeProjectName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Validate that a project name is not empty/whitespace-only.
 */
function validateProjectName(name: string): void {
  if (!name || !name.trim()) {
    throw new Error('Project name cannot be empty or whitespace-only');
  }
}

/**
 * Generate an opaque stable ID for a new project.
 * Uses current timestamp and a random suffix for uniqueness.
 */
function generateProjectId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 9);
  return `p_${timestamp}_${random}`;
}

/**
 * Registry for managing projects in IndexedDB.
 * Handles database lifecycle, CRUD operations, and unique name enforcement.
 */
export class ProjectRegistry {
  private db: IDBPDatabase<any> | null = null;
  private dbName: string;

  constructor(dbName: string) {
    this.dbName = dbName;
  }

  /**
   * Initialize the registry database.
   * Sets up the projects store and indexes if needed.
   */
  async init(): Promise<void> {
    this.db = await openDB(this.dbName, 1, {
      upgrade(db) {
        // Create the projects store if it doesn't exist
        if (!db.objectStoreNames.contains('projects')) {
          const store = db.createObjectStore('projects', { keyPath: 'id' });

          // Create index for normalized name lookups (for unique constraint)
          store.createIndex('by-name-key', 'nameKey', { unique: false });

          // Create index for ordering by creation time
          store.createIndex('by-created', 'createdAt', { unique: false });
        }

        // Create the sync state store if it doesn't exist
        if (!db.objectStoreNames.contains('_syncStates')) {
          db.createObjectStore('_syncStates', { keyPath: 'projectId' });
        }
      },
    });
  }

  /**
   * Ensure database is initialized before operations.
   */
  private ensureDb(): IDBPDatabase<any> {
    if (!this.db) {
      throw new Error('Registry not initialized. Call init() first.');
    }
    return this.db;
  }

  /**
   * Strip internal fields from a project record to return the public Project type.
   */
  private stripInternal(record: ProjectRecord): Project {
    const { nameKey, ...project } = record;
    return project;
  }

  /**
   * Create a new project with a unique name.
   */
  async create(name: string): Promise<Project> {
    validateProjectName(name);

    const db = this.ensureDb();
    const normalized = normalizeProjectName(name);

    // Check for existing project with same normalized name
    const existing = await db.getFromIndex('projects', 'by-name-key', normalized);
    if (existing) {
      throw new Error(`Project "${name}" already exists`);
    }

    const record: ProjectRecord = {
      id: generateProjectId(),
      name: name.trim(),
      nameKey: normalized,
      createdAt: new Date().toISOString(),
    };

    await db.add('projects', record);
    return this.stripInternal(record);
  }

  /**
   * List all projects sorted by createdAt ascending.
   * If projects have the same createdAt, they're sorted by id.
   */
  async list(): Promise<Project[]> {
    const db = this.ensureDb();
    const records = await db.getAllFromIndex('projects', 'by-created');

    // Sort by createdAt ascending, then by id for tie-breaking
    records.sort((a, b) => {
      const timeCompare = a.createdAt.localeCompare(b.createdAt);
      if (timeCompare !== 0) return timeCompare;
      return a.id.localeCompare(b.id);
    });

    return records.map(r => this.stripInternal(r));
  }

  /**
   * Get a single project by id.
   */
  async get(id: string): Promise<Project | null> {
    const db = this.ensureDb();
    const record = await db.get('projects', id);
    return record ? this.stripInternal(record) : null;
  }

  /**
   * Rename a project to a new unique name.
   */
  async rename(id: string, newName: string): Promise<Project> {
    validateProjectName(newName);

    const db = this.ensureDb();
    const record = await db.get('projects', id);

    if (!record) {
      throw new Error(`Project with id "${id}" not found`);
    }

    const normalizedNew = normalizeProjectName(newName);

    // Check if new name is already in use by a different project
    const existing = await db.getFromIndex('projects', 'by-name-key', normalizedNew);
    if (existing && existing.id !== id) {
      throw new Error(`Project "${newName}" already exists`);
    }

    // Update the project record
    const updated: ProjectRecord = {
      ...record,
      name: newName.trim(),
      nameKey: normalizedNew,
    };

    await db.put('projects', updated);
    return this.stripInternal(updated);
  }

  /**
   * Remove a project by id.
   * This is a no-op if the project doesn't exist (no error thrown).
   * Never touches Drive files (decision 31).
   */
  async remove(id: string): Promise<void> {
    const db = this.ensureDb();
    // Use delete which is a no-op if the key doesn't exist
    await db.delete('projects', id);
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

/**
 * Internal project record with nameKey field for indexing.
 * The nameKey is not part of the public Project interface but is stored in IDB.
 */
interface ProjectRecord extends Project {
  nameKey: string;
}
