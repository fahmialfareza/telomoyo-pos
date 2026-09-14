# Telomoyo POS Mobile

Expo SDK 57 / React Native 0.86 Android client for local-first operation on
phones and MPOS terminals.

The public app name is Telomoyo POS. The legacy application ID, Expo slug and
scheme, encrypted SQLite filenames, SecureStore keys, background task ID, and
printer module namespace are intentionally retained so version `0.2.0` can be
installed over an existing build without losing device-local state.

## State and persistence

- Zustand owns live authentication and synchronization state in
  `src/auth/auth-store.ts` and `src/sync/sync-store.ts`.
- SecureStore remains the encrypted persistence boundary for session tokens and
  the terminal Ed25519 private key. Secrets are not persisted by a general
  Zustand storage adapter.
- Encrypted SQLite is the UI read model and durable offline queue. Signed outbox
  operations are sent FIFO and remote changes are pulled by cursor.
- Provider components only attach startup, network, foreground, and background
  lifecycle events. Screens consume selector-backed hooks to avoid broad context
  rerenders.
- `index.js` imports the background-sync task before `expo-router/entry`. Keep
  that order so Android cold-starts define the TaskManager headless task before
  native background work begins.

## Development

```sh
pnpm --filter @sewa-motor/mobile check-types
pnpm --filter @sewa-motor/mobile lint
pnpm --filter @sewa-motor/mobile test
pnpm --filter @sewa-motor/mobile start
```

Expo Go cannot load SQLCipher or the local printer module. Generate only the
Android native project and run a development client:

```sh
pnpm --filter @sewa-motor/mobile native:prebuild
pnpm --filter @sewa-motor/mobile android
```

The Android application ID is `com.fahmialfareza.sewamotorpos` and is kept in
`app.config.ts`. Run `native:prebuild` after changing native configuration so
the generated Android project cannot retain stale values.

`pnpm --filter @sewa-motor/mobile build` performs a Metro Android export. A
signed APK/AAB still requires EAS project ownership, keystore/Play
configuration, and an environment-specific API URL.

For the responsive controls and management/transaction workflow changes, use
the [mobile UI acceptance checklist](../../docs/mobile-ui-acceptance.md). Native
keyboard, footer placement, and Bluetooth/integrated MPOS printing still need
device acceptance in addition to the automated suite.

## Printer boundary

The local Expo module exposes integrated and Bluetooth adapter boundaries plus a
simulator. The vendor AAR/JAR, supported paper width, encoding, timeout
semantics, and device identifiers must be supplied for the selected MPOS model
before physical acceptance. Every attempted print is stored with
pending/success/failed/unknown state so an uncertain hardware result is never
silently treated as success.
