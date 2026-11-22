# @open-webapp/contacts

Read-only Google Contacts sync (People API `connections` and `otherContacts`) into host-supplied storage, with email-to-name/photo lookup across one or more Google accounts, plus React `useContact` and `Avatar`. The package has no OAuth and no storage implementation: the host supplies `getToken`, a `StorageAdapter`, and any encryption.

> **0.1.0 is the initial release.** See [0.1.0](#010-initial-release).

## Install

```bash
npm install @open-webapp/contacts
```

Peer: `react ^19` (only needed for `@open-webapp/contacts/react`). `vitest ^2.1.0 || ^4` is an optional peer, needed only for `@open-webapp/contacts/testing`'s `runStorageAdapterContract`.

## Entry points

| Import | Contents |
| --- | --- |
| `@open-webapp/contacts` | core: `createContactsController`, `lookupByEmail`, `syncSource`, `syncAccount`, `SOURCES`, normalize helpers, record/person types, typed errors, `StorageAdapter`, `FetchFn` |
| `@open-webapp/contacts/react` | `ContactsProvider`, `useContactsController`, `useContact`, `Avatar`, `AvatarProps` |
| `@open-webapp/contacts/testing` | `runStorageAdapterContract`, `storageContractCases`, `ContractCase`, `StorageContractHarness`, `rec`, `createMemoryStorage`, `installFakeFetch`, `FakeReply`, `PERSON_ADA`, `PERSON_BOB`, `PEOPLE_FIXTURES` |
| `@open-webapp/contacts/styles.css` | stylesheet for `Avatar` (import once) |

The core entry does not import React.

## Scopes

The host requests the OAuth scopes; the package never runs consent. Request both for full coverage:

| Scope | Used for |
| --- | --- |
| `https://www.googleapis.com/auth/contacts.readonly` | `people/me/connections` (the `connections` source) |
| `https://www.googleapis.com/auth/contacts.other.readonly` | `otherContacts` (the "Other contacts" source) |

Each source is requested separately. If one scope is missing, only that source fails (with `ContactsScopeError`); the other source still syncs. Nothing is written by this package.

## Usage

```ts
import { createContactsController } from '@open-webapp/contacts';
import '@open-webapp/contacts/styles.css';

const contacts = createContactsController({
  accounts: [
    { id: 'work', getToken: async () => accessTokenFor('work') },
    { id: 'personal', getToken: async () => accessTokenFor('personal') },
  ],
  storage,          // StorageAdapter (host)
  // fetch?: FetchFn  optional, defaults to globalThis.fetch
});

void contacts.sync();                                  // full or incremental, per source
const match = await contacts.lookupByEmail('Ada@Example.com');
// -> { name: 'Ada Lovelace', photoUrl: 'https://…=s64' } | undefined
```

### Controller

`createContactsController({ accounts, storage, fetch? })` returns a `ContactsController`:

| Member | Behavior |
| --- | --- |
| `sync(): Promise<void>` | Syncs every account x source. Concurrent calls share one in-flight run. Never rejects; per-source failures go to `getStatus()`. After `dispose()` it resolves without fetching. |
| `lookupByEmail(email): Promise<ContactMatch \| undefined>` | Reads storage only (no network). See [Multi-account merge](#multi-account-merge). |
| `subscribe(listener): () => void` | `listener()` runs after each completed `sync()` pass (not per source). A throwing listener is logged and does not stop the others. |
| `getStatus(): ContactsStatus` | `{ accounts }`: per-account `AccountSyncStatus` from the most recent pass. `accounts` is empty until the first pass completes. |
| `dispose(): void` | Clears all listeners; later `sync()` calls are no-ops. `lookupByEmail` still reads storage. |

`ContactsAccount` is `{ id: string; getToken: () => Promise<string> }`. `ContactsControllerOptions` is `{ accounts; storage; fetch? }`. `ContactsStatus` is `{ accounts: Partial<Record<string, AccountSyncStatus>> }`.

`getStatus()` shape:

```ts
{
  accounts: {
    work: { connections: { ok: true }, otherContacts: { ok: false, error: ContactsScopeError } },
  },
}
```

`SourceStatus` is `{ ok: true } | { ok: false; error: unknown }`. `AccountSyncStatus` is `Record<Source, SourceStatus>`.

### Standalone helpers

Without the controller, a host can drive sync itself:

- `syncSource({ accountId, source, storage, getToken, fetch?, now? })`: one account, one source. Throws on error.
- `syncAccount({ accountId, storage, getToken, fetch?, now? })`: both sources, independently. Returns `AccountSyncStatus`; never throws.
- `SOURCES`: `['connections', 'otherContacts']`.
- `lookupByEmail(storage, accountIds, email)`: the lookup used by the controller; `accountIds` order is the merge priority.

## Sync behavior

Per account and per source (`connections`, `otherContacts`):

1. Read the stored `SyncRecord`. If it has a `syncToken`, run an **incremental** request (`syncToken` sent). Otherwise run a **full** request.
2. Full sync: `storage.replaceSource(accountId, source, records)` replaces every record for that account and source.
3. Incremental sync: `storage.applyDelta(accountId, source, upserts, deletes)`. `deletes` are the `resourceName`s reported deleted by Google, plus people that no longer produce a record (for example, a contact that lost all its emails).
4. `storage.putSync(accountId, source, { syncToken, lastSyncAt })` stores the new token and time.

**Sync token expiry.** Google expires sync tokens after about 7 days. An incremental request that returns HTTP 400 is treated as an expired token: the package drops the token and runs a full sync for that source, which replaces that source's records. Expiry never surfaces in `getStatus()`.

**Pagination and atomicity.** Every page is fetched before any write. A failure on any page (including page 2 or later) throws before storage is touched, so the previous records and `SyncRecord` remain. Within the package, `replaceSource` and `putSync` are two storage calls; a host adapter should make them atomic if a crash between them matters (a missing token only means one extra full sync).

**Partial failure.** Each source syncs independently. If `connections` fails (for example, 500), its previous cache and token are kept, `otherContacts` still syncs, and `getStatus()` reports `{ ok: false, error }` for `connections` only. `lookupByEmail` keeps returning cached data from the failed source.

**Deleted contacts.** Google marks deleted people (`deleted: true` or `metadata.deleted: true`). Full syncs ignore them; incremental syncs remove them from storage.

**Request shape.** `GET https://people.googleapis.com/v1/people/me/connections` (`personFields=names,emailAddresses,photos`) and `GET https://people.googleapis.com/v1/otherContacts` (`readMask=names,emailAddresses,photos`). Both send `requestSyncToken=true`, `pageSize=1000`, `Authorization: Bearer <token>`, and follow `nextPageToken`. `getToken()` is called before each source's request sequence, so an expiry fallback to a full sync calls it again.

## Records and normalization

Storage holds one `ContactRecord` per Google person per account and source:

```ts
interface ContactRecord {
  key: string;          // `${accountId}:${resourceName}`
  accountId: string;
  source: 'connections' | 'otherContacts';
  resourceName: string; // 'people/c123' or 'otherContacts/c456'
  name?: string;        // first non-empty displayName, trimmed
  nameNorm?: string;    // name lowercased, trimmed, diacritics removed (NFD, combining marks stripped)
  emails: string[];     // every email, trimmed and lowercased
  emailsNorm: string[]; // same as emails (kept for index use)
  photoUrl?: string;    // see photo rule below
}
```

- A person without a `resourceName`, or with no non-empty email, produces no record (no throw).
- Every email is indexed; a person with two emails is found by either.
- Photos: the first `photos[]` entry with a URL and `default !== true` is used. The size suffix is normalized to `=s64` (an existing `=sNN` or `=sNN-…` suffix is replaced; otherwise `=s64` is appended). A person with only default photos has no `photoUrl`.
- Records without a name still match by email (`{ photoUrl }` or `{}` results).

`SyncRecord` is `{ syncToken?: string; lastSyncAt: number }`.

Exported normalizers: `normalizeEmail(email)` (trim, lowercase), `normalizeName(name)` (NFD, strip combining marks, trim, lowercase), `normalizePhotoUrl(url)` (the `=s64` rule), `personToRecord(person, accountId, source)` (returns `ContactRecord | undefined`).

## Lookup and multi-account merge

`lookupByEmail(email)` normalizes the input (trim, lowercase), reads `storage.getByEmail(emailNorm)`, then walks `accounts` in the order the host passed to `createContactsController`:

1. For the first account that has any matching record, pick the `connections` record if one exists, otherwise an `otherContacts` record.
2. Return `{ name?, photoUrl? }` from that single record. Name and photo always come from the same record.
3. If no account matches, return `undefined`.

So when two accounts know the same email with different names, the earlier account in `accounts` wins, and swapping the order swaps the result. Records from accounts not listed in `accounts` are ignored; removing an account from the controller does not delete its cache (call `storage.clear(accountId)` for that).

`ContactMatch` is `{ name?: string; photoUrl?: string }`. Absent fields are omitted, not `undefined` values.

## Adapters

### StorageAdapter

The host implements this interface (`StorageAdapter`, exported from `.`):

```ts
interface StorageAdapter {
  getSync(accountId: string, source: Source): Promise<SyncRecord | undefined>;
  putSync(accountId: string, source: Source, sync: SyncRecord): Promise<void>;
  replaceSource(accountId: string, source: Source, records: ContactRecord[]): Promise<void>;
  applyDelta(accountId: string, source: Source, upserts: ContactRecord[], deleteResourceNames: string[]): Promise<void>;
  getByEmail(emailNorm: string): Promise<ContactRecord[]>;  // all accounts, all sources
  listAll(): Promise<ContactRecord[]>;
  clear(accountId: string): Promise<void>;                  // that account's records and sync rows
}
```

Semantics:

- `replaceSource` removes every record with that `accountId` and `source`, then writes `records`. It must not touch the other source or other accounts.
- `applyDelta` deletes the listed `resourceName`s for that `accountId` and `source`, then upserts (by `key`).
- `getByEmail` returns every matching record across accounts; `lookupByEmail` does the account ordering.
- `clear` removes only that account (records and sync rows).

Suggested IndexedDB layout for a host adapter (not shipped by this package):

| Store | keyPath | Indexes |
| --- | --- | --- |
| `records` | `key` | `emailsNorm`: keyPath `emailsNorm`, **multiEntry: true** (one row per email, for `getByEmail`); `nameNorm`: keyPath `nameNorm` (prefix-ready, for a future prefix search; rows without a name are absent from this index); `accountId` (recommended, for `clear` and `replaceSource`) |
| `sync` | `[accountId, source]` | none |

The `emailsNorm` multi-entry index and the `nameNorm` index are part of the documented schema so that a later prefix-search API needs no migration. Version 0.1.0 exposes no prefix API; the reference memory adapter filters a `Map` and does not use index order.

The package has no crypto adapter. A host that wants encryption at rest must encrypt inside its own adapter, and then the indexed fields must remain in clear form for the index to work.

### Contract harness

`runStorageAdapterContract(factory)` (from `@open-webapp/contacts/testing`, needs `vitest`) registers the contract as vitest cases. The factory returns a fresh, empty adapter per test:

```ts
import { describe } from 'vitest';
import { runStorageAdapterContract } from '@open-webapp/contacts/testing';
import { createIdbContactsStorage } from './idbStorage';

describe('IDB contacts storage', () => {
  runStorageAdapterContract(async () => ({
    storage: await createIdbContactsStorage(freshDbName()),
    seedRaw: (row) => rawPut(row),     // optional: write a row bypassing normalization
    legacyRow,                          // optional: a legacy-shape row
    corruptRow,                         // optional: a row the host considers corrupt
  }));
});
```

`StorageContractHarness` is `{ storage: StorageAdapter; seedRaw?: (row: unknown) => Promise<void>; legacyRow?: ContactRecord; corruptRow?: unknown }`. The legacy and corrupt cases are skipped when `seedRaw` is omitted (the corrupt case also needs `corruptRow`).

The eight contract cases:

1. `replaceSource` then `getByEmail` / `listAll` return the records.
2. `replaceSource` drops previous records of that account and source only.
3. `applyDelta` upserts and deletes by `resourceName`.
4. `getByEmail` is multi-entry: one email in several records (across accounts) returns all.
5. `putSync` / `getSync` round-trip per account and source.
6. `clear(account)` removes only that account's records and sync rows.
7. A legacy row (optional fields missing) written with `seedRaw` is readable.
8. A corrupt row written with `seedRaw` does not throw or hide good rows.

`storageContractCases()` returns the same cases as plain `{ name, run(factory) }` objects, for hosts that use another runner. `createMemoryStorage()` is the reference adapter (a `Map` with filter scans) and passes the contract.

## React

```tsx
import { ContactsProvider, useContact, Avatar } from '@open-webapp/contacts/react';

<ContactsProvider controller={contacts}>
  <App />
</ContactsProvider>

function Attendee({ email }: { email: string }) {
  const c = useContact(email);                       // undefined until a lookup resolves
  return <Avatar email={email} name={c?.name} photoUrl={c?.photoUrl} size={24} />;
}
```

- `ContactsProvider({ controller, children })`: supplies the controller. Without it, hooks return `undefined` and do not throw.
- `useContactsController()`: the controller from context, or `undefined`.
- `useContact(email: string | undefined): ContactMatch | undefined`: subscribes to the controller and re-runs `lookupByEmail` after each sync pass. Returns `undefined` for an undefined email, no controller, no match, or before the first lookup resolves. The snapshot is stable across re-renders when the value is unchanged.
- `Avatar({ email?, name?, photoUrl?, size? })` (`AvatarProps`): a round `span` (default `size` 32px). Shows the `photoUrl` `img` (`alt=""`, `referrerPolicy="no-referrer"`). If the image fails to load, it falls back to initials for that URL. Initials: up to two words from `name`, first letter of each, uppercase (`"Ada Lovelace"` -> `AL`, `"Ada"` -> `A`); with no name, the first letter of the email local part; otherwise `?`.

Styles (`styles.css`): classes `.contacts-avatar`, `.contacts-avatar__img`, `.contacts-avatar__initials`. Override colors with `--contacts-avatar-bg` and `--contacts-avatar-fg`. Dark defaults apply under `prefers-color-scheme: dark` only; the package has no `data-theme` switch.

## Host wiring: calendar `resolveContact`

`@open-webapp/calendar` takes a **synchronous** `resolveContact?: (email: string) => { name?: string; photoUrl?: string } | undefined` on `CalendarPane` (0.16.0). The package has no dependency on contacts, so the host bridges it. `lookupByEmail` is async, so the host fills a cache and returns from it synchronously:

```tsx
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { createContactsController, normalizeEmail, type ContactMatch } from '@open-webapp/contacts';
import { CalendarPane } from '@open-webapp/calendar';

function useCalendarContacts(controller: ReturnType<typeof createContactsController>, emails: string[]) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const cache = useRef(new Map<string, ContactMatch | undefined>());
  const key = emails.map(normalizeEmail).sort().join('\n');

  useEffect(() => {
    let live = true;
    const prime = async () => {
      await Promise.all(
        key.split('\n').filter(Boolean).map(async (e) => cache.current.set(e, await controller.lookupByEmail(e))),
      );
      if (live) bump();
    };
    void prime();
    const unsub = controller.subscribe(() => void prime());  // re-read after each sync pass
    return () => { live = false; unsub(); };
  }, [controller, key]);

  return (email: string) => cache.current.get(normalizeEmail(email));
}

// in the host component:
const resolveContact = useCalendarContacts(contacts, attendeeEmails);
<CalendarPane /* ...calendar props... */ resolveContact={resolveContact} />
```

On the first paint a contact is not yet cached, so the calendar falls back to its `displayName`/email until the lookup resolves. Call `controller.sync()` on app start and after sign-in.

## Errors

All exported from `@open-webapp/contacts`; `getStatus()` error values are these instances (or the raw error for network failures).

| Error | Thrown when | Scope |
| --- | --- | --- |
| `ContactsAuthError` | HTTP 401 | the source |
| `ContactsScopeError` | HTTP 403 (any; the package cannot tell scope issues apart) | the source |
| `SyncTokenExpiredError` | HTTP 400 on an incremental request | caught internally: full resync, never reported |
| `ContactsFetchError` (`status: number`) | any other non-2xx, including 400 on a full sync | the source |

Errors from `getToken()` and network failures (`fetch` rejects) propagate unchanged. Each one is recorded for that source; the other source and other accounts still run. Auth and scope errors are not retried automatically; the host re-consents or re-authenticates and calls `sync()` again.

## Testing

`@open-webapp/contacts/testing` exports `createMemoryStorage()`, `runStorageAdapterContract`, `storageContractCases`, `installFakeFetch(router)` (replaces `globalThis.fetch`, returns `{ log, restore }`; `router` returns a `FakeReply`: `{ status, body? }` or `'network-error'`), and fixtures: `PERSON_ADA`, `PERSON_BOB`, `PEOPLE_FIXTURES`, `rec(accountId, source, id, emails)` (builds a `ContactRecord`), and types `ContractCase`, `StorageContractHarness`, `FakeReply`.

## 0.1.0 (initial release)

- Read-only Google Contacts sync (`connections`, `otherContacts`) with full and incremental sync, sync-token expiry handling, and per-source failure isolation.
- Email lookup across ordered accounts; typed errors; `StorageAdapter` plus `runStorageAdapterContract`.
- React `ContactsProvider`, `useContact`, `Avatar`, and `styles.css`.
