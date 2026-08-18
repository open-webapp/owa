/**
 * Testing utilities for @open-webapp/project-sync
 *
 * In-memory fakes that compose with drive-sync's existing fakes
 * to enable complete end-to-end testing without any network calls.
 *
 * Contract test suites for verifying merge and document I/O implementations.
 */

export { createProjectRegistryFake, ProjectRegistryFake } from './registryFake.js';
export { createDriveFolderFake, type DriveFolderFake } from './driveFolderFake.js';
export { describeMergeContract, describeDocumentContract, type MergeFixtures } from './contracts.js';
