import { runStorageAdapterContract } from '../index.js';
import { createMemoryStorage, identityCrypto } from '../index.js';

runStorageAdapterContract(() => {
  const storage = createMemoryStorage();
  return {
    storage,
    crypto: identityCrypto,
    seedRaw: async (id, row) => void storage.rows.set(id, row),
    wrongKeyCrypto: {
      encrypt: identityCrypto.encrypt,
      decrypt: async () => {
        throw new Error('OperationError');
      },
    },
  };
});
