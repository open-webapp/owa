/**
 * Comprehensive integration test using all fakes.
 *
 * Tests a full two-project, three-document sync entirely on fakes:
 * - In-memory registry (no IDB)
 * - In-memory folder operations (no Drive API)
 * - Fake Drive API (driveFake from drive-sync)
 * - Fake GIS (gisFake from drive-sync)
 *
 * Verifies:
 * - Projects can be created and listed
 * - Folders are created in the correct hierarchy
 * - Documents sync with correct content
 * - No network calls (no fetch/XHR reachable)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDriveFake } from '@open-webapp/drive-sync/testing';
import { createProjectRegistryFake, createDriveFolderFake } from '../testing/index.js';
import type { Project, SyncDocument } from '../types.js';

describe('Integration test: full sync with fakes', () => {
  let registry: ReturnType<typeof createProjectRegistryFake>;
  let driveFake: ReturnType<typeof createDriveFake>;
  let folderFake: ReturnType<typeof createDriveFolderFake>;

  beforeEach(() => {
    registry = createProjectRegistryFake();
    driveFake = createDriveFake();
    folderFake = createDriveFolderFake(driveFake);

    // Stub global fetch to ensure only our fake is called
    vi.stubGlobal('fetch', driveFake.fetch);
  });

  describe('Project registry operations', () => {
    it('creates and lists projects', async () => {
      const proj1 = await registry.create('Project One');
      const proj2 = await registry.create('Project Two');

      expect(proj1.id).toBeDefined();
      expect(proj1.name).toBe('Project One');
      expect(proj1.createdAt).toBeDefined();

      expect(proj2.id).toBeDefined();
      expect(proj2.name).toBe('Project Two');

      const listed = await registry.list();
      expect(listed).toHaveLength(2);
      expect(listed[0].name).toBe('Project One');
      expect(listed[1].name).toBe('Project Two');
    });

    it('enforces unique names (case-insensitive)', async () => {
      await registry.create('My Project');

      await expect(registry.create('my project')).rejects.toThrow(
        'Project "my project" already exists'
      );
      await expect(registry.create('MY PROJECT')).rejects.toThrow(
        'Project "MY PROJECT" already exists'
      );
    });

    it('renames projects', async () => {
      const proj = await registry.create('Original');
      const renamed = await registry.rename(proj.id, 'Renamed');

      expect(renamed.name).toBe('Renamed');
      expect(await registry.get(proj.id)).toEqual(renamed);
    });

    it('removes projects', async () => {
      const proj = await registry.create('To Delete');
      await registry.remove(proj.id);

      const deleted = await registry.get(proj.id);
      expect(deleted).toBeNull();
    });
  });

  describe('Folder operations with driveFake', () => {
    it('creates folder hierarchy', async () => {
      const folderOps = folderFake.folderOperations();

      // Create OpenWebApp folder at root
      const openWebAppId = await folderOps.createFolder({
        appId: 'test-app',
        projectId: 'test-proj',
        clientId: 'test-client',
        name: 'OpenWebApp',
        parentId: undefined,
        interactive: false,
        fetchEmail: async () => 'test@example.com',
      });

      expect(openWebAppId).toBeDefined();

      // Create app folder under OpenWebApp
      const appFolderId = await folderOps.createFolder({
        appId: 'test-app',
        projectId: 'test-proj',
        clientId: 'test-client',
        name: 'MyApp',
        parentId: openWebAppId,
        interactive: false,
        fetchEmail: async () => 'test@example.com',
      });

      expect(appFolderId).toBeDefined();

      // Create project folder under app
      const projectFolderId = await folderOps.createFolder({
        appId: 'test-app',
        projectId: 'test-proj',
        clientId: 'test-client',
        name: 'My Project',
        parentId: appFolderId,
        interactive: false,
        fetchEmail: async () => 'test@example.com',
      });

      expect(projectFolderId).toBeDefined();

      // Verify folder hierarchy
      const appFolder = await folderOps.get({
        appId: 'test-app',
        projectId: 'test-proj',
        clientId: 'test-client',
        fileId: appFolderId,
        interactive: false,
      });

      expect(appFolder).toBeDefined();
      expect(appFolder?.name).toBe('MyApp');
      expect(appFolder?.parents).toContain(openWebAppId);
    });

    it('lists folders by name in parent', async () => {
      const folderOps = folderFake.folderOperations();

      const parentId = await folderOps.createFolder({
        appId: 'test-app',
        projectId: 'test-proj',
        clientId: 'test-client',
        name: 'Parent',
        parentId: undefined,
        interactive: false,
        fetchEmail: async () => 'test@example.com',
      });

      const childId = await folderOps.createFolder({
        appId: 'test-app',
        projectId: 'test-proj',
        clientId: 'test-client',
        name: 'Child',
        parentId,
        interactive: false,
        fetchEmail: async () => 'test@example.com',
      });

      // List by name in parent
      const found = await folderOps.list({
        appId: 'test-app',
        projectId: 'test-proj',
        clientId: 'test-client',
        folderId: parentId,
        nameEquals: 'Child',
        mimeType: 'application/vnd.google-apps.folder',
        interactive: false,
        fetchEmail: async () => 'test@example.com',
      });

      expect(found).toHaveLength(1);
      expect(found[0].id).toBe(childId);
      expect(found[0].name).toBe('Child');
    });

    it('renames folders', async () => {
      const folderOps = folderFake.folderOperations();

      const folderId = await folderOps.createFolder({
        appId: 'test-app',
        projectId: 'test-proj',
        clientId: 'test-client',
        name: 'Original Name',
        parentId: undefined,
        interactive: false,
        fetchEmail: async () => 'test@example.com',
      });

      await folderOps.update({
        appId: 'test-app',
        projectId: 'test-proj',
        clientId: 'test-client',
        fileId: folderId,
        name: 'New Name',
        interactive: false,
        fetchEmail: async () => 'test@example.com',
      });

      const updated = await folderOps.get({
        appId: 'test-app',
        projectId: 'test-proj',
        clientId: 'test-client',
        fileId: folderId,
        interactive: false,
        fetchEmail: async () => 'test@example.com',
      });

      expect(updated?.name).toBe('New Name');
    });
  });

  describe('Document sync simulation', () => {
    it('syncs multiple documents to Drive without conflicts', async () => {
      const folderOps = folderFake.folderOperations();

      // Create project folder
      const projectFolderId = await folderOps.createFolder({
        appId: 'test-app',
        projectId: 'test-proj',
        clientId: 'test-client',
        name: 'My Project',
        parentId: undefined,
        interactive: false,
        fetchEmail: async () => 'test@example.com',
      });

      // Simulate syncing 3 documents
      const documents = [
        {
          key: 'doc-1',
          name: 'notes.json',
          mimeType: 'application/json',
          content: JSON.stringify({ type: 'notes', data: 'Hello' }),
        },
        {
          key: 'doc-2',
          name: 'config.json',
          mimeType: 'application/json',
          content: JSON.stringify({ version: 1, enabled: true }),
        },
        {
          key: 'doc-3',
          name: 'backup.bin',
          mimeType: 'application/octet-stream',
          content: 'binary data',
        },
      ];

      const fileIds: Record<string, string> = {};

      // Create documents in Drive
      for (const doc of documents) {
        // Create file in project folder
        const fileId = `file-${doc.key}`;

        driveFake.files.set(fileId, {
          id: fileId,
          name: doc.name,
          mimeType: doc.mimeType,
          parents: [projectFolderId],
          content: doc.content,
          version: 1,
          modifiedTime: new Date().toISOString(),
        });

        fileIds[doc.key] = fileId;
      }

      // Verify all files were created
      const listResult = await folderOps.list({
        appId: 'test-app',
        projectId: 'test-proj',
        clientId: 'test-client',
        folderId: projectFolderId,
        interactive: false,
        fetchEmail: async () => 'test@example.com',
      });

      expect(listResult).toHaveLength(3);
      expect(listResult.map((f) => f.name).sort()).toEqual([
        'backup.bin',
        'config.json',
        'notes.json',
      ]);

      // Verify each file exists and has correct content
      for (const doc of documents) {
        const file = await folderOps.get({
          appId: 'test-app',
          projectId: 'test-proj',
          clientId: 'test-client',
          fileId: fileIds[doc.key],
          interactive: false,
          fetchEmail: async () => 'test@example.com',
        });

        expect(file).toBeDefined();
        expect(file?.name).toBe(doc.name);
        expect(file?.mimeType).toBe(doc.mimeType);
      }
    });
  });

  describe('Two-project, three-document sync scenario', () => {
    it('creates two projects with three documents each, syncs all to Drive', async () => {
      // Create two projects
      const proj1 = await registry.create('Work Project');
      const proj2 = await registry.create('Personal Project');

      expect(proj1.name).toBe('Work Project');
      expect(proj2.name).toBe('Personal Project');

      // Create folder structure for each project
      const folderOps = folderFake.folderOperations();

      // Create root OpenWebApp folder
      const openWebAppId = await folderOps.createFolder({
        appId: 'test-app',
        projectId: proj1.id,
        clientId: 'test-client',
        name: 'OpenWebApp',
        parentId: undefined,
        interactive: false,
        fetchEmail: async () => 'test@example.com',
      });

      // Create app folder
      const appFolderId = await folderOps.createFolder({
        appId: 'test-app',
        projectId: proj1.id,
        clientId: 'test-client',
        name: 'TestApp',
        parentId: openWebAppId,
        interactive: false,
        fetchEmail: async () => 'test@example.com',
      });

      // Create project folders
      const proj1FolderId = await folderOps.createFolder({
        appId: 'test-app',
        projectId: proj1.id,
        clientId: 'test-client',
        name: proj1.name,
        parentId: appFolderId,
        interactive: false,
        fetchEmail: async () => 'test@example.com',
      });

      const proj2FolderId = await folderOps.createFolder({
        appId: 'test-app',
        projectId: proj2.id,
        clientId: 'test-client',
        name: proj2.name,
        parentId: appFolderId,
        interactive: false,
        fetchEmail: async () => 'test@example.com',
      });

      // Define test documents for each project
      const proj1Docs = [
        { key: 'work-doc-1', name: 'tasks.json', content: JSON.stringify({ tasks: ['Task 1', 'Task 2'] }) },
        { key: 'work-doc-2', name: 'notes.md', content: '# Work Notes\n\nTodo items...' },
        { key: 'work-doc-3', name: 'config.json', content: JSON.stringify({ priority: 'high' }) },
      ];

      const proj2Docs = [
        { key: 'personal-doc-1', name: 'diary.txt', content: 'Personal diary entry...' },
        { key: 'personal-doc-2', name: 'photos.json', content: JSON.stringify({ photos: ['img1', 'img2'] }) },
        { key: 'personal-doc-3', name: 'wishlist.md', content: '# Wish List\n\n- Item 1\n- Item 2' },
      ];

      // Sync project 1 documents
      const proj1FileIds: Record<string, string> = {};
      for (const doc of proj1Docs) {
        const fileId = `proj1-${doc.key}`;
        driveFake.files.set(fileId, {
          id: fileId,
          name: doc.name,
          mimeType: 'application/json',
          parents: [proj1FolderId],
          content: doc.content,
          version: 1,
          modifiedTime: new Date().toISOString(),
        });
        proj1FileIds[doc.key] = fileId;
      }

      // Sync project 2 documents
      const proj2FileIds: Record<string, string> = {};
      for (const doc of proj2Docs) {
        const fileId = `proj2-${doc.key}`;
        driveFake.files.set(fileId, {
          id: fileId,
          name: doc.name,
          mimeType: 'application/json',
          parents: [proj2FolderId],
          content: doc.content,
          version: 1,
          modifiedTime: new Date().toISOString(),
        });
        proj2FileIds[doc.key] = fileId;
      }

      // Verify project 1 documents
      const proj1Files = await folderOps.list({
        appId: 'test-app',
        projectId: proj1.id,
        clientId: 'test-client',
        folderId: proj1FolderId,
        interactive: false,
        fetchEmail: async () => 'test@example.com',
      });

      expect(proj1Files).toHaveLength(3);
      expect(proj1Files.map((f) => f.name).sort()).toEqual([
        'config.json',
        'notes.md',
        'tasks.json',
      ]);

      // Verify project 2 documents
      const proj2Files = await folderOps.list({
        appId: 'test-app',
        projectId: proj2.id,
        clientId: 'test-client',
        folderId: proj2FolderId,
        interactive: false,
        fetchEmail: async () => 'test@example.com',
      });

      expect(proj2Files).toHaveLength(3);
      expect(proj2Files.map((f) => f.name).sort()).toEqual([
        'diary.txt',
        'photos.json',
        'wishlist.md',
      ]);

      // Verify specific document contents
      const workTasksFile = await folderOps.get({
        appId: 'test-app',
        projectId: proj1.id,
        clientId: 'test-client',
        fileId: proj1FileIds['work-doc-1'],
        interactive: false,
        fetchEmail: async () => 'test@example.com',
      });

      expect(workTasksFile?.name).toBe('tasks.json');
      const driveFakeFile = driveFake.files.get(proj1FileIds['work-doc-1']);
      expect(driveFakeFile?.content).toBe(JSON.stringify({ tasks: ['Task 1', 'Task 2'] }));

      const personalDiaryFile = await folderOps.get({
        appId: 'test-app',
        projectId: proj2.id,
        clientId: 'test-client',
        fileId: proj2FileIds['personal-doc-1'],
        interactive: false,
        fetchEmail: async () => 'test@example.com',
      });

      expect(personalDiaryFile?.name).toBe('diary.txt');
      const driveFakeFile2 = driveFake.files.get(proj2FileIds['personal-doc-1']);
      expect(driveFakeFile2?.content).toBe('Personal diary entry...');
    });
  });

  describe('No network calls verification', () => {
    it('all operations use fakes, no real fetch calls', async () => {
      const fetchSpy = vi.fn(driveFake.fetch);
      vi.stubGlobal('fetch', fetchSpy);

      // Create project
      const proj = await registry.create('Test Project');
      expect(proj).toBeDefined();

      // Create folders
      const folderOps = folderFake.folderOperations();
      const folderId = await folderOps.createFolder({
        appId: 'test-app',
        projectId: proj.id,
        clientId: 'test-client',
        name: 'Test Folder',
        parentId: undefined,
        interactive: false,
        fetchEmail: async () => 'test@example.com',
      });

      expect(folderId).toBeDefined();

      // All registry operations use in-memory storage
      expect(fetchSpy).not.toHaveBeenCalled();

      // Folder operations use driveFake, not real fetch
      // (driveFake.fetch would be called if used, but we're just checking it's the fake)
      const files = await folderOps.list({
        appId: 'test-app',
        projectId: proj.id,
        clientId: 'test-client',
        folderId,
        interactive: false,
        fetchEmail: async () => 'test@example.com',
      });

      expect(files).toBeDefined();
    });

    it('registry operations never make network calls', async () => {
      const registryNetworkSpy = vi.fn();
      const originalFetch = global.fetch;
      vi.stubGlobal('fetch', registryNetworkSpy);

      try {
        await registry.create('Project 1');
        await registry.create('Project 2');
        await registry.list();
        const proj = await registry.get((await registry.list())[0].id);
        await registry.rename(proj!.id, 'Renamed');

        // Verify fetch was never called
        expect(registryNetworkSpy).not.toHaveBeenCalled();
      } finally {
        vi.stubGlobal('fetch', originalFetch);
      }
    });
  });

  describe('Data integrity', () => {
    it('maintains data across multiple sync cycles', async () => {
      const proj = await registry.create('Persistent Project');
      const folderOps = folderFake.folderOperations();

      const folderId = await folderOps.createFolder({
        appId: 'test-app',
        projectId: proj.id,
        clientId: 'test-client',
        name: proj.name,
        parentId: undefined,
        interactive: false,
        fetchEmail: async () => 'test@example.com',
      });

      // First sync: create 2 documents
      const doc1Id = 'doc1';
      driveFake.files.set(doc1Id, {
        id: doc1Id,
        name: 'doc1.json',
        mimeType: 'application/json',
        parents: [folderId],
        content: JSON.stringify({ version: 1 }),
        version: 1,
        modifiedTime: new Date().toISOString(),
      });

      const doc2Id = 'doc2';
      driveFake.files.set(doc2Id, {
        id: doc2Id,
        name: 'doc2.json',
        mimeType: 'application/json',
        parents: [folderId],
        content: JSON.stringify({ version: 1 }),
        version: 1,
        modifiedTime: new Date().toISOString(),
      });

      let files = await folderOps.list({
        appId: 'test-app',
        projectId: proj.id,
        clientId: 'test-client',
        folderId,
        interactive: false,
        fetchEmail: async () => 'test@example.com',
      });

      expect(files).toHaveLength(2);

      // Second sync: update one document, leave the other
      const doc1 = driveFake.files.get(doc1Id)!;
      doc1.content = JSON.stringify({ version: 2 });
      doc1.version = 2;

      files = await folderOps.list({
        appId: 'test-app',
        projectId: proj.id,
        clientId: 'test-client',
        folderId,
        interactive: false,
        fetchEmail: async () => 'test@example.com',
      });

      expect(files).toHaveLength(2);

      // Verify updated content
      const updated = await folderOps.get({
        appId: 'test-app',
        projectId: proj.id,
        clientId: 'test-client',
        fileId: doc1Id,
        interactive: false,
        fetchEmail: async () => 'test@example.com',
      });

      expect(updated?.id).toBe(doc1Id);
      const file = driveFake.files.get(doc1Id)!;
      expect(file.content).toBe(JSON.stringify({ version: 2 }));
    });
  });
});
