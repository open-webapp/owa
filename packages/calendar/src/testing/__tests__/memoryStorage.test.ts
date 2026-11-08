import { afterEach, beforeEach, describe, vi } from 'vitest';
import { runStorageAdapterContract } from '../index.js';
import { createMemoryStorage, identityCrypto } from '../index.js';

describe.each(['2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z'])('with wall clock at %s', (date) => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(date));
  });
  afterEach(() => vi.useRealTimers());

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
});
