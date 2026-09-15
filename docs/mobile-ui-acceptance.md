# Mobile UI acceptance checklist

Scope: consistent sizing and clearer workflows for Telomoyo POS. Roboto,
branding, permissions, payment rules, synchronization contracts, encrypted
storage identifiers, and receipt content/layout remain unchanged. Physical
ESC/POS output now enables bold emphasis for readability without changing
character width or requesting model-specific heat/density settings.

## Automated verification

The implementation has passed these checks locally:

```sh
pnpm --filter @sewa-motor/mobile test
pnpm --filter @sewa-motor/mobile check-types
pnpm --filter @sewa-motor/mobile exec eslint src --no-cache
pnpm --filter @sewa-motor/mobile build
```

An ARM64 Android debug build also passed with JDK 21, from
`apps/mobile/android`:

```sh
./gradlew :app:assembleDebug -PreactNativeArchitectures=arm64-v8a --offline
```

Component/navigation tests cover sizing breakpoints, action stacking, footer
insets and measurement, confirmation cancellation/session changes, management
transitions and explicit retries, history search/filter pagination, independent
password access, QRIS activation/cancellation, and receipt/print safeguards.
These tests do not replace native layout, keyboard, or printer acceptance.

## Native device checks — pending

Use authorized test accounts and Sandbox data. Sandbox QRIS uses real merchant
payments; scanning and paying is optional for UI checks and must be explicitly
authorized. Payment confirmation remains manual.

- [ ] Inspect 320, 360, 390, 414, and 768 dp widths at font scales 1.0, 1.2,
      and 1.5. Rotate/resize; check wrapped labels, centered tablet content,
      48 dp actions, and 56 dp inputs. Cover login, forms, dashboard, packages,
      history, management, settings, and transaction screens.
- [ ] Check gesture and three-button Android navigation. Open the keyboard on
      narrow screens; verify the last input and every sticky action remain
      reachable. Scroll oversized footer groups and confirm no covered content
      or duplicated tab-bar/bottom-safe-area spacing.
- [ ] Open Pengguna by pressing its tab as Superadmin. Confirm the staff
      directory appears immediately inside the Pengguna bottom tab without a
      context exchange or terminal-enrollment flash. Create, edit, cancel, and password recovery
      must keep the tab bar visible. Verify loading, empty, no-results, icon
      refresh/retry, and whole-row account opening.
- [ ] Open Kelola tenant from Pengaturan. Confirm it remains under the
      Pengaturan tab, Back returns to the settings menu, and neither direction
      exchanges context or shows the mode-operation loader.
- [ ] Nested user-editor Back first returns to the in-tab directory. Tapping
      Beranda, Transaksi, Riwayat, or Pengaturan from Pengguna opens that tab
      directly without showing terminal enrollment or changing the active mode.
      failed returns must remain blocked with retry feedback. Continuing the selected healthy
      business in the chooser must retain its session and Sandbox mode.
- [ ] Check Pilih bisnis and Pengelolaan use Settings-style rows and header
      refresh icons, without an Akun saya section. Confirm active selection,
      disabled/inactive businesses, and refresh loading states are clear.
- [ ] Check tenant list-first editing, one expanded editor, explicit save/cancel,
      creation restrictions, activate/suspend confirmations, immutable codes,
      separate receipt identity, and absence of tenant deletion.
- [ ] Open the independent Ganti kata sandi screen from Pengaturan. Akun saya
      must contain no duplicate password section or button. Check direct
      authenticated password-screen access without a business, forced-password
      changes, Sandbox restrictions, and show/hide toggles on password fields.
- [ ] Reveal history search, submit, edit an unapplied draft, and hide it. Verify
      the applied chip remains, pagination/date/month retain the query, reopening
      retains the draft, and chip removal clears the query and resets paging.
- [ ] Cancel app confirmations with Batal and Android Back: no mutation occurs.
      Confirm once despite repeated taps, inspect retry after failure, and verify
      pending confirmations disappear when the session/context changes.
- [ ] Verify QRIS remains above the summary. Try image/camera selection and
      cancellation without saving; check read-only payload and the explicitly
      labeled activation switch, including historical-only imports.
- [ ] Inspect detail/print sticky actions for pending, failed, successful,
      corrected, archived, and conflicted transactions with both roles. Only
      currently permitted actions should appear; print requires successful
      payment for the current revision. Cetak nanti remains outlined and returns
      to history; successful printing offers Home and Copy.
- [ ] Compare 32- and 48-column preview/simulator output with Bluetooth and
      integrated MPOS prints. Confirm unchanged Production content/layout, Sandbox
      warnings/amounts, copy markers, frozen receipt identity, and simulator
      wording. Preview alone must not create a print attempt.
- [ ] Print both widths with Production and Sandbox test records. Verify every
      printed line is bolder and readable, including cashier, items, amounts,
      and warnings; the following print must not inherit stale alignment or
      emphasis. If still faint, inspect printer-specific density, paper, power,
      and printhead condition separately. Do not assume a universal density
      command works on every MPOS. The integrated adapter requires its actual
      vendor SDK; automated byte tests do not establish hardware compatibility.
- [ ] Attempt context switching/Back during a physical print, then test success,
      failure, and uncertain results. Confirm the print barrier covers the whole
      hardware attempt and no receipt is attributed to a different business.
- [ ] Recheck foreground, network-recovery, periodic, and background sync on the
      active tenant/mode after navigation changes. Account management must not
      open a business database.

Record device/MPOS model, Android version, paper width, font scale, and results
before release. No physical-device or printer acceptance is claimed by the
automated checks above.
