# Contacts product behavior

Source of truth: this package's code and tests in `packages/contacts`. "Package" lists what the library does; "Host" lists what the app owns.

## Package

- Syncs each account's Google Contacts `connections` (people the user knows) and `otherContacts` (addresses Google suggests) separately. Both are read-only.
- Each contact is kept only if it has at least one email address. Contacts without an email are not stored and never match.
- Every email on a contact is searchable. Lookup ignores case and surrounding spaces.
- A name comes from the contact's first non-empty display name, trimmed. Email lookup returns this name as stored; the folded form used for future name search is kept in storage but not used by any v1 API.
- A photo comes from the contact's first non-default photo, requested at 64px. Google's placeholder photos are ignored, and the UI falls back to initials.
- Multiple accounts: the first account in the host's list that knows the email wins. Within that account, the connections entry is preferred over other contacts. The name and photo always come from the same entry.
- Removed contacts disappear on the next sync (incremental syncs apply deletions; full resyncs replace the source).
- If Google's incremental sync token has expired (about 7 days), the next sync silently refreshes that source in full.
- A failed source keeps its last good contacts. The other source and other accounts still sync. The host sees per-source status (ok or error) after each sync.
- Missing permission (scope) or an expired sign-in (401) is reported per source; the package never prompts for consent.
- `Avatar` shows the photo when there is one and a load succeeds; otherwise it shows up to two initials from the name, or the first letter of the email address, or `?`.
- Lookups return nothing until the first sync has run for that data; they never trigger network calls.

## Host

- Creates the controller with its accounts (in priority order), a token getter per account, and the storage adapter. Calls `sync()` on start and when it chooses (for example, after sign-in or on a timer).
- Requests the two Google scopes and handles sign-in and re-consent when a source reports a scope or auth error.
- Stores the cache in its own database and encrypts it if it needs to. Clears an account's cache when the account is removed (`clear(accountId)`).
- Wires lookups into the UI. For the calendar, it passes a synchronous `resolveContact` backed by `lookupByEmail`, and accepts that the first paint shows the event's own name until the lookup resolves.
- Decides what to show for each error. The package reports errors but does not show any UI.
