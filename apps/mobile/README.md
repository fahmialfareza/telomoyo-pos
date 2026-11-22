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

## Over-the-air updates

Production and preview builds load JS/asset updates from EAS Update on their
build's channel. A downloaded update applies on the next cold start; startup
never waits for the network, so offline devices keep running the bundle they
have. `runtimeVersion` uses the fingerprint policy, so an update only reaches
builds with identical native code.

- **What can ship OTA:** JS, styles, and assets. Anything that changes the
  fingerprint (new or bumped native dependencies, Expo upgrades, config plugins,
  `app.config.ts` native settings, a new app version) needs a store build via
  `pnpm release:mobile`. `eas update` publishes to the runtime it computes, so
  an incompatible update is never delivered to an older build.
- **Publishing:** test on the preview channel with a preview APK first, then
  `pnpm update:mobile:preview` / `pnpm update:mobile` from the repo root.
- **Code signing:** devices only accept bundles signed by the key matching
  `certs/certificate.pem`. The private key lives at `keys/private-key.pem`
  (gitignored), is stored as the EAS secret file variable
  `EXPO_UPDATES_PRIVATE_KEY`, and is backed up in the password manager. In CI,
  pass `--private-key-path "$EXPO_UPDATES_PRIVATE_KEY"` instead. Losing the key
  means a new store build with a new certificate.
- **Local SQLite migrations are forward-only.** Never roll back or republish an
  older update after one that shipped a migration in `src/db/migrations.ts`;
  the device database would be ahead of the code. Fix forward with a new update.

For the responsive controls and management/transaction workflow changes, use
the [mobile UI acceptance checklist](../../docs/mobile-ui-acceptance.md). Native
keyboard, footer placement, and Bluetooth/integrated MPOS printing still need
device acceptance in addition to the automated suite.

## Staff management navigation

Pengguna stays in the bottom tab for the directory, account creation, role/status
editing, and password recovery, and **Kelola tenant** stays under Pengaturan.
Organization management is authorized for an active Superadmin account or a
selected-business session, so opening those tabs neither exchanges context, shows
a terminal-enrollment flash, nor switches the active business or its database.
The retired platform permission remains rejected.

Legacy `/management/users` routes redirect into the tab. The Pilih bisnis chooser
still exchanges into account context through the online sync/outbox drain and
physical-print barrier, remembers the previous business for Back, and keeps
explicit retry feedback. Moving between bottom tabs keeps the current authorized
tenant. Account-profile editing has no duplicate password action; the independent
password screen remains in Settings and preserves forced-password-change and
Sandbox restrictions.

## Printer boundary

The local Expo module exposes integrated and Bluetooth adapter boundaries plus a
simulator. The vendor AAR/JAR, supported paper width, encoding, timeout
semantics, and device identifiers must be supplied for the selected MPOS model
before physical acceptance. Every attempted print is stored with
pending/success/failed/unknown state so an uncertain hardware result is never
silently treated as success.

The shared ESC/POS encoder uses emphasized (bold) text for the entire receipt,
then restores normal emphasis and left alignment before cutting. Receipt text,
paper columns, payment-success gating, Sandbox labels, and copy attribution are
unchanged. Physical darkness still depends on the printer, paper, and device
settings; no vendor-specific heating/density command is issued.
