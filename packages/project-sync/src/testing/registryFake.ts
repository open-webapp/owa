/**
 * In-memory fake of ProjectRegistry for testing.
 *
 * Provides the same CRUD interface as ProjectRegistry but stores
 * projects in memory with no IndexedDB access, making tests
 * completely deterministic and network-independent.
 */

import type { Project } from '../types.js';

/**
 * Internal project record with nameKey field for indexing.
 */
interface ProjectRecord extends Project {
  nameKey: string;
}

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
 * In-memory fake registry for testing.
 * Implements the same interface as ProjectRegistry but stores data in memory.
 */
export class ProjectRegistryFake {
  private projects: Map<string, ProjectRecord> = new Map();
  private nameIndex: Map<string, string> = new Map(); // normalized name -> project id
  private createdAtCounter = 0; // Counter to ensure unique timestamps

  /**
   * Create a new project with a unique name.
   */
  async create(name: string): Promise<Project> {
    validateProjectName(name);

    const normalized = normalizeProjectName(name);

    // Check for existing project with same normalized name
    if (this.nameIndex.has(normalized)) {
      throw new Error(`Project "${name}" already exists`);
    }

    // Use counter to ensure unique timestamps for deterministic ordering
    const baseTime = Date.now();
    const createdAt = new Date(baseTime + this.createdAtCounter).toISOString();
    this.createdAtCounter += 1;

    const record: ProjectRecord = {
      id: generateProjectId(),
      name: name.trim(),
      nameKey: normalized,
      createdAt,
    };

    this.projects.set(record.id, record);
    this.nameIndex.set(normalized, record.id);
    return this.stripInternal(record);
  }

  /**
   * List all projects sorted by createdAt ascending.
   */
  async list(): Promise<Project[]> {
    const records = Array.from(this.projects.values());

    // Sort by createdAt ascending, then by id for tie-breaking
    records.sort((a, b) => {
      const timeCompare = a.createdAt.localeCompare(b.createdAt);
      if (timeCompare !== 0) return timeCompare;
      return a.id.localeCompare(b.id);
    });

    return records.map((r) => this.stripInternal(r));
  }

  /**
   * Get a single project by id.
   */
  async get(id: string): Promise<Project | null> {
    const record = this.projects.get(id);
    return record ? this.stripInternal(record) : null;
  }

  /**
   * Rename a project to a new unique name.
   */
  async rename(id: string, newName: string): Promise<Project> {
    validateProjectName(newName);

    const record = this.projects.get(id);
    if (!record) {
      throw new Error(`Project with id "${id}" not found`);
    }

    const normalizedNew = normalizeProjectName(newName);

    // Check if new name is already in use by a different project
    const existingId = this.nameIndex.get(normalizedNew);
    if (existingId && existingId !== id) {
      throw new Error(`Project "${newName}" already exists`);
    }

    // Remove old name from index
    this.nameIndex.delete(record.nameKey);

    // Update the project record
    record.name = newName.trim();
    record.nameKey = normalizedNew;

    // Add new name to index
    this.nameIndex.set(normalizedNew, id);

    return this.stripInternal(record);
  }

  /**
   * Remove a project by id.
   * This is a no-op if the project doesn't exist (no error thrown).
   */
  async remove(id: string): Promise<void> {
    const record = this.projects.get(id);
    if (record) {
      this.nameIndex.delete(record.nameKey);
      this.projects.delete(id);
    }
  }

  /**
   * Strip internal fields from a project record to return the public Project type.
   */
  private stripInternal(record: ProjectRecord): Project {
    const { nameKey, ...project } = record;
    return project;
  }

  /**
   * Clear all projects (for testing).
   */
  clear(): void {
    this.projects.clear();
    this.nameIndex.clear();
    this.createdAtCounter = 0;
  }
}

/**
 * Create a new in-memory fake registry for testing.
 */
export function createProjectRegistryFake(): ProjectRegistryFake {
  return new ProjectRegistryFake();
}
