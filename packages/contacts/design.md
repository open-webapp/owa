# @open-webapp/contacts design

## Layers

- `core/`: framework-free. `types` (records, sync record, `Person`, typed errors), `normalize` (email/name/photo, `personToRecord`), `fetch` (People REST, paging, status to error mapping), `sync` (per-source full/incremental, per-account settle), `lookup` (multi-account merge), `storage` (adapter type), `controller`.
- `react/`: `ContactsProvider`, `useContactsController`, `useContact`, `Avatar`, `styles.css`. Consumes the controller via `subscribe` and `lookupByEmail`.
- `testing/`: memory adapter, storage contract, fake fetch, People fixtures; published as `./testing`.

## Decisions

- Host owns OAuth, storage and encryption. The package takes `getToken()` per account and a `StorageAdapter`; no IndexedDB, crypto or OAuth dependency.
- Read-only. Scopes (`contacts.readonly`, `contacts.other.readonly`) are host-requested and documented only.
- Each source (`connections`, `otherContacts`) has its own sync token, its own status and its own failure domain. One failing source keeps its previous cache and token, and the other still syncs.
- All pages of a source are fetched before any write, so a mid-pagination failure never leaves a partial source.
- Incremental sync uses the stored token and applies deletes; HTTP 400 on an incremental request is an expired token (about 7 days) and falls back to a full replace for that source. The fallback is internal and does not appear in status.
- Records are one per (account, Google person, source). Every email is indexed in lowercase, so one contact with several addresses is found by any of them.
- Index shape is decided now: `emailsNorm` multi-entry and `nameNorm` (diacritic-folded, lowercase) are the indexed fields. The reference memory adapter filters a `Map`; hosts index in IndexedDB. Prefix search is not in v1, so the index is not yet read in order.
- Multi-account merge is by account order, not by recency or source trust. Within an account, `connections` beats `otherContacts`. The whole result comes from one record, so a name never mixes with a photo from another contact.
- Photos are stored as a URL string with size normalized to `=s64`. Default placeholder photos are skipped. Photo bytes are not cached by the package.
- The controller's sync never rejects. Errors are data in `getStatus()`, so UI can show them without try/catch around sync.
- `useContact` is a per-(controller, email) external store with a stable snapshot and a stale-response guard, so unrelated re-renders do not churn consumers.
- `Avatar` falls back to initials on missing or failed photos. Failure is remembered per URL, so a broken URL does not re-request on every render.
- The core entry has no React import, so non-React hosts and workers can use it.
