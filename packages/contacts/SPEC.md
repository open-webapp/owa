# @open-webapp/contacts SPEC

## Scope

Read-only Google Contacts sync for N accounts, into host-supplied storage, with email lookup and React presentation (`useContact`, `Avatar`). No OAuth and no consent UI: the host provides `getToken()` per account and requests the scopes `contacts.readonly` and `contacts.other.readonly`. No writes to Google. No crypto adapter.

## Public surface

Package exports: `.`, `./react`, `./testing`, `./styles.css`.

`.` (core, framework-free):

- Controller: `createContactsController`, `ContactsController`, `ContactsControllerOptions`, `ContactsAccount`, `ContactsStatus`.
- Lookup: `lookupByEmail(storage, accountIds, email)`, `ContactMatch`.
- Sync: `syncSource`, `syncAccount`, `SOURCES`, `SyncSourceOptions`, `SyncAccountOptions`, `SourceStatus`, `AccountSyncStatus`.
- Fetch: `FetchFn` (type only; `fetchPeople` is internal).
- Storage: `StorageAdapter` (type).
- Normalize: `normalizeEmail`, `normalizeName`, `normalizePhotoUrl`, `personToRecord`.
- Types: `ContactRecord`, `SyncRecord`, `Source`, `Person`, `PersonName`, `PersonEmail`, `PersonPhoto`.
- Errors (classes): `ContactsAuthError`, `ContactsScopeError`, `ContactsFetchError`, `SyncTokenExpiredError`.

`./react`: `ContactsProvider`, `useContactsController`, `useContact`, `Avatar`, `AvatarProps`.

`./testing` (requires optional peer `vitest`): `runStorageAdapterContract`, `storageContractCases`, `ContractCase`, `StorageContractHarness`, `rec`, `createMemoryStorage`, `installFakeFetch`, `FakeReply`, `PERSON_ADA`, `PERSON_BOB`, `PEOPLE_FIXTURES`.

`./styles.css`: `.contacts-avatar`, `.contacts-avatar__img`, `.contacts-avatar__initials`.

## Controller invariants

1. `sync()` never rejects. It runs every account x source concurrently (`Promise.allSettled` per account). Concurrent calls share one in-flight run.
2. `sync()` after `dispose()` resolves without fetching.
3. `getStatus()` is replaced wholesale after each completed pass; before the first pass it is `{ accounts: {} }`. Each account entry is `{ connections: SourceStatus, otherContacts: SourceStatus }`.
4. Subscribers are notified once per completed pass, not per source. A throwing subscriber is logged and does not block others or `sync()`. Listeners are not notified after `dispose()`.
5. `lookupByEmail` reads storage only (no network) and works after `dispose()`.
6. `lookupByEmail` considers only the accounts passed in `accounts`; their order is the merge priority.

## Sync

Per (account, source), `syncSource`:

1. `getSync(accountId, source)`. If `syncToken` is present, request incrementally.
2. HTTP 400 on an incremental request -> `SyncTokenExpiredError` internally -> full request.
3. Full: `replaceSource(accountId, source, records)`. Incremental: `applyDelta(accountId, source, upserts, [...deletedResourceNames, ...droppedResourceNames])`, where dropped are people who yield no record.
4. `putSync(accountId, source, { syncToken: nextSyncToken, lastSyncAt })`.

Invariants:

- All pages are fetched before any write. Any page failure leaves storage (records and `SyncRecord`) untouched for that source.
- A failing source does not affect the other source or other accounts; its prior cache and token remain.
- Full sync ignores `deleted` entries; incremental applies them.
- `nextSyncToken` is taken from the last page that carries one. If none, `putSync` stores `syncToken: undefined` and the next pass is full.
- Requests: `people/me/connections` with `personFields`, `otherContacts` with `readMask`; both `names,emailAddresses,photos`, `requestSyncToken=true`, `pageSize=1000`, `Bearer` auth, `nextPageToken` paging.

## Errors

| Condition | Error |
| --- | --- |
| HTTP 401 | `ContactsAuthError` |
| HTTP 403 | `ContactsScopeError` |
| HTTP 400 with `syncToken` | `SyncTokenExpiredError` (internal; resync) |
| Other non-2xx (incl. 400 without token) | `ContactsFetchError(status)` |
| `getToken()` rejects, `fetch` rejects, invalid JSON | propagated as thrown |

Errors surface only via `getStatus()` (for controller) or `syncSource` rejection (for helpers).

## Records and normalization

- `ContactRecord`: `{ key, accountId, source, resourceName, name?, nameNorm?, emails, emailsNorm, photoUrl? }`. `key` is `${accountId}:${resourceName}`.
- Person without `resourceName` or without any non-empty email yields no record.
- Emails: trimmed and lowercased; every email kept.
- `name`: first non-empty trimmed `displayName`. `nameNorm`: NFD, combining marks stripped, trimmed, lowercased.
- Photo: first `photos[]` entry with `url` and `default !== true`. Size normalized to `=s64` (replace `=sNN` / `=sNN-…` suffix, else append `=s64`).
- `normalizeEmail` = trim + lowercase. `lookupByEmail` applies it to input.

## Lookup

`lookupByEmail(email)`: `getByEmail(normalizeEmail(email))`, then for each account id in order, pick the first record for that account (`connections` before `otherContacts`) and return `{ name?, photoUrl? }` from that record only. No match in any account -> `undefined`. Absent fields are omitted.

## Adapter contract

`StorageAdapter` methods: `getSync`, `putSync`, `replaceSource`, `applyDelta`, `getByEmail`, `listAll`, `clear`.

- `replaceSource` and `applyDelta` are scoped to `(accountId, source)`.
- `applyDelta` deletes by `resourceName`, then upserts by `key`.
- `getByEmail` is multi-entry across accounts and sources.
- `clear(accountId)` removes that account's records and sync rows only.
- `runStorageAdapterContract` runs the eight cases from `storageContractCases()`: replaceSource round-trip; replaceSource scoped to account and source; applyDelta upsert and delete; multi-entry getByEmail; sync round-trip; clear isolation; legacy row (via `seedRaw`); corrupt row (via `seedRaw`).

Index design (documented for host schemas; no prefix API in v1): `records` store keyed by `key` with multi-entry `emailsNorm` and `nameNorm` indexes, so a later prefix search needs no migration. `sync` store keyed by `[accountId, source]`.

## React contract

- `ContactsProvider({ controller, children })`; `useContactsController()` returns the controller or `undefined`.
- `useContact(email)`: `undefined` for undefined email, no controller, no match, or pending first lookup. Re-runs `lookupByEmail` on each controller notification, guarded against stale responses, and only changes the snapshot when name or photo changes.
- `Avatar({ email?, name?, photoUrl?, size = 32 })`: photo `img` when `photoUrl` is set and has not failed; otherwise initials. Failure is remembered per URL. Initials: up to two words (first letter each, uppercase) from `name`; else first letter of the email local part; else `?`.

## Styling

`styles.css` is a single stylesheet for `Avatar`. Colors come from `--contacts-avatar-bg` and `--contacts-avatar-fg` with light defaults and dark defaults under `prefers-color-scheme: dark`.

## Versioning

0.1.0 initial release. Peer: `react ^19`; optional peer `vitest ^2.1.0`. The calendar package does not depend on this package; hosts connect them through a `resolveContact` function.
