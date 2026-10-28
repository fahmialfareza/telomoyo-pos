# Internal Telomoyo POS operations and release acceptance

## Scope and permissions

Tenants are business units of **Pengelola Wisata Telomoyo**, not separate staff
organizations. Exactly two global roles exist: `admin` and `superadmin`.
Every active account can select every active tenant, including newly created
ones. Historical membership rows remain attribution/constraint links, not role
or access grants. There is no independent Platform Admin permission or User role,
and invitations are removed.

Admin can use dashboards, history, reports, transactions, and successful-payment
printing; corrections and payment confirmation are limited to their own
transactions. Superadmin can handle any transaction in the selected tenant and
manage catalogs, merchant configuration, terminals, Sandbox resets, tenants, and
global staff accounts. Account context is used for organization management and
must not open a business database.

Tenant UUID `00000000-0000-4000-8000-000000000200` is migrated **Telomoyo**.
Production space `00000000-0000-4000-8000-000000000100`, existing IDs, encrypted
files/keys, and signed evidence remain unchanged. Catalogs, transactions, QRIS,
receipt identity, reports, terminals, sync, and Sandbox remain tenant-isolated:
cross-tenant identifiers return `404` even when the account may separately
switch to that business. New tenants start active with an empty catalog, initial
receipt identity, IDR, and `Asia/Jakarta`. Management names and receipt identity
are edited independently; tenant IDs/slugs stay immutable. Preserved
`pending_setup` tenants require explicit activation. No tenant/account deletion,
billing, branches, custom logos, or combined business reporting is introduced.

```dotenv
TENANT_PROVISIONING_ENABLED=false
SANDBOX_ENABLED=false
SANDBOX_RETENTION_DAYS=30
SANDBOX_CLEANUP_INTERVAL=24h
```

Provisioning controls creation only, not access to existing tenants. Suspension
preserves data and requires fresh authorization after reactivation. Sandbox has
an independent lifecycle per tenant. The deprecated
`SANDBOX_QRIS_AMOUNT=1000` setting may remain during transition with a warning;
it does not override the full-value policy. Do not set another fixed amount.

## Safe rollout and rollback boundaries

1. Capture a verified operator-controlled full recovery point. Rehearse GORM
   migrations through `000006_internal_organization` on a populated disposable
   restore; compare IDs, balances, revisions, stored amounts, origin sessions,
   encrypted files, and exact signed queue bytes before/after.
2. Review global-role mapping: active accounts with an active Superadmin
   membership or legacy Platform Admin flag become global Superadmin; other
   active staff become Admin. Disabled/deleted accounts remain disabled.
   Historical memberships remain, outstanding invitations are invalidated, and
   `account.global_role_migrated` audit records explain the mapping.
3. Keep provisioning disabled and stop **all incompatible backend replicas**
   before changing authorization models. Run the one-shot `migrate` image, then
   compatible replicas with `AUTO_MIGRATE=false`. Membership-authority and
   fixed-only Sandbox binaries cannot safely coexist with this release.
4. Verify legacy Telomoyo sessions, cursors, signed outboxes, reports, and
   historical QRIS bindings. Release protocol-v3 mobile without reinstalling or
   clearing app data. Verify account-context management and scope remounting.
5. Drain legacy Sandbox outboxes online before session upgrade; compare old
   Rp1.000 payments/reprints with new full-total creates/corrections. Failed
   upgrades must not silently create full-value work under a legacy session.
6. Complete acceptance gates below. Superadmins use **Pengguna** for global staff
   and **Bisnis & tenant → Kelola tenant** for business management. No platform
   assignment or invitation is needed. Enable provisioning only after confirming
   all replicas and installed clients are compatible.

Rollback must retain tenant-aware isolation, global-role authorization, and
immutable payment-policy interpretation. Never restore binaries that revive
membership approval or interpret full-value sessions as Rp1.000.
`TENANT_PROVISIONING_ENABLED=false` stops creation only;
`SANDBOX_ENABLED=false` independently stops new Sandbox entry without affecting
Production sessions/readiness. Neither switch reverses migration or data.

## Global staff and audited operator operations

Superadmins use account-context `/management/users` to create global staff with
temporary passwords, change roles/status, and recover passwords. Creation and
recovery force a password change before POS use. Role changes, deactivation,
and recovery revoke every account session across all tenants. Self-demotion/
deactivation and removal of the last active Superadmin are forbidden.
Reactivation never revives old sessions. Personal profile/password changes remain
account-owner actions.

The operator tool is a maintenance/recovery path, not mobile authorization. It
requires an existing active account, explicit target, responsible operator,
action, and reason. Obtain recovery authorization out of band. `--operator`
is audit attribution, not authentication: protect database credentials and retain
host/container access logs. Never put credentials or raw QRIS in `--reason`.

```sh
pnpm --filter @sewa-motor/backend account:admin \
  --action grant-superadmin --username approved.operator \
  --operator on-call@example.test --reason 'Approved organization Superadmin recovery'
```

`revoke-superadmin` demotes to global Admin and refuses to remove the last active
Superadmin. Both role changes revoke all sessions; an already-applied role is
audited without unnecessary revocation. Retired `grant-platform` and
`revoke-platform` fail explicitly, never alias the broader global actions.
Historical memberships and the legacy platform flag are not modified.

`reset-password` accepts the temporary password **only through stdin**, never
an argument or environment variable. For example, in zsh:

```sh
read -rs 'temporary_password?Temporary password: '
printf '\n'
printf '%s' "$temporary_password" | pnpm --filter @sewa-motor/backend account:admin \
  --action reset-password --username approved.account \
  --operator on-call@example.test --reason 'Verified account-owner recovery'
unset temporary_password
```

Use a unique temporary password of 8–256 bytes. Recovery sets
`must_change_password=true` and revokes account, tenant, and historical platform
sessions with `password_recovered`; role changes use `account_access_changed`.
Sign in online and change the temporary password where required. Neither
operation rewrites/re-signs/transfers queued evidence. Matching origin authority
must be explicitly revalidated before replay.

Operator operations share the mobile account-administration advisory lock and
append immutable `operator.*` records to `platform_audit_events` (the retained
physical name for organization control-plane history). Credentials never enter
audit or synchronized account projections.

```sh
docker build --target account-admin -t telomoyo-pos:account-admin apps/backend
docker run --rm --env DATABASE_URL \
  telomoyo-pos:account-admin --action grant-superadmin --username approved.operator \
  --operator on-call@example.test --reason 'Approved organization Superadmin recovery'
```

For recovery add `docker run --interactive` and pipe protected input. The separate
non-root image never runs migrations automatically. Do not expose it as HTTP or
include operator tooling in the serving image.

## Sessions, compatibility, and offline recovery

New clients negotiate protocol **3**. Only account and tenant contexts are
issued. `GET /auth/contexts` lists all active tenants and management/provisioning
capabilities. Login enters the sole tenant's Production space or shows a chooser.
Every tenant switch enters Production; current tenant/mode persists across
restart while its session remains valid.

Exchanges issue a new session and revoke the old one without changing historical
actor, tenant, membership, enrollment, space, or policy. Ordinary business APIs
derive scope only from the session. Obsolete platform/member administration
returns an upgrade error; invitation endpoints return an explicit removal error.
They never reinterpret legacy membership edits as global account changes.

Cursors bind `tenant:<tenantUUID>:<spaceUUID>:<generation>:<position>`. Only
migrated Telomoyo accepts numeric Production and
`sandbox:<generation>:<position>` legacy cursors. Signed mutations are assessed
against the persisted origin session, not the uploading app version.

Online switching blocks new writes, waits for active sync and the entire physical
print attempt, and drains the outbox. Discovered suspension, enrollment revocation,
or global account access changes lock the affected local scope. Evidence remains
quarantined by tenant/space/origin account/session/enrollment. Another login or
tenant switch must not release it. Restore matching authority and explicitly
revalidate online using `/sync/revalidate`. Never clear app data, rotate another
tenant's key, or replace signed actor/session/payload/signature fields in recovery.

### Shared physical devices and enrollment

In Settings, **Bisnis & tenant** contains **Ganti bisnis**, **Kelola tenant**,
and **Identitas struk** according to permission. The persistent business label
also opens the chooser. Entering **Pengguna** or **Kelola tenant** exchanges
into account context through the same synchronization/printing barrier; it
does not reuse or open a tenant database for global management.

A Superadmin enrolls a phone/MPOS separately in each selected tenant, in
Production mode. An Admin may operate an existing valid enrollment on that
shared installation, but cannot create or revoke one. A fresh or revoked
enrollment therefore requires Superadmin setup before cashier use. Existing
Telomoyo keys/enrollment remain unchanged. Enrollment evidence and signing keys
are tenant-specific; printer preferences remain physical-device settings.
Revocation in one tenant must neither rotate another tenant's key nor discard
pending evidence. Test a Superadmin-to-Admin handoff on the same installation
without clearing app data, including a second business and a revoked enrollment.

### Terminal revocation versus a lost device

Revoking a terminal ends the **enrollment**, not the account. It deactivates the
installation's signing key in that tenant, so it can no longer create, correct,
confirm, print, or push signed mutations there, and revokes sessions bound to
the terminal with `terminal_revoked`. That reason is intentionally recoverable:
the session may still call `/auth/contexts`, `/auth/switch-context`, and
`/auth/logout`, and switching issues a new account or tenant session without a
terminal. That session keeps read access (dashboards, history, reports, exports,
sync pull) and, for a Superadmin, management actions. This lets a shared
installation recover from revocation without clearing app data.

To fully cut off a lost or stolen device, revoke the terminal **and** end the
signed-in account's sessions: in **Pengguna**, reset its password
(`password_recovered`) or deactivate it (`account_access_changed`), or use the
`reset-password` operator action. These revoke every session of the account
and cannot be recovered through switch-context. A password change by the owner
on another device (`password_changed`) also revokes the lost device's sessions.

## Accepted risks and intended behavior

Reviewed and accepted; do not re-report these as vulnerabilities.

- **Terminal revocation keeps switch-context recovery.** A `terminal_revoked`
  session can obtain a terminal-less session through `/auth/switch-context`.
  Lost devices also need a password reset or deactivation; see
  [Terminal revocation versus a lost device](#terminal-revocation-versus-a-lost-device).
- **Sales may use superseded or deleted package revisions.** Transaction create
  and correct (online and sync push) price each line from any existing package
  revision in the data space, including superseded revisions and soft-deleted
  packages, so offline devices with a stale catalog can still sync. The server
  prices from the stored revision, never from client amounts, and each
  transaction line keeps the package revision it used.

## Real-value Sandbox and receipt history

Protocol-v3 sessions bind `sandboxQrisPolicy=transaction_total`. New Sandbox
cash and QRIS use the actual Sandbox catalog total, independently of Production
prices. The tenant's real merchant QRIS is used. Display
`QRIS UJI NYATA — Rp{nominal} akan masuk ke rekening merchant` above it.
Paying transfers real money; success/failure remains manually confirmed and
requires merchant reconciliation.

Legacy sessions bind `fixed_1000`; legacy-origin signed QRIS mutations still
calculate Rp1.000 even when uploaded by a protocol-v3 client/session. Preserve
stored payment amounts, historical QR codes, and reprints. Explicit corrections
create a new revision under its origin policy and require payment confirmation
again. `/auth/upgrade-session` preserves tenant, mode, generation, and enrollment
while negotiating protocol 3 after the legacy outbox drains. Full-value Sandbox
status has policy information and a nullable fixed amount.

QRIS and receipt identity are versioned per tenant. Only Production-mode
Superadmins update them. Importing old device QRIS requires explicit Telomoyo
Superadmin confirmation; historical payloads retain their exact hashes. An
unavailable historical payload must never silently display another QRIS.
Transactions snapshot receipt business name/address/phone and profile revision.

One formatter supplies scrollable monospaced 32/48-column preview, simulator,
Bluetooth, and integrated MPOS. Preview creates no print attempt; simulator
results explicitly identify simulation. Printing requires successful payment on
the current revision, a frozen document, and the switch barrier throughout the
attempt. Sandbox retains compact permanent `TEST — MODE UJI` /
`BUKAN STRUK RESMI` labels and `TEST-` IDs. Historical Rp1.000 receipts show
distinct order/payment amounts; Production output remains unchanged. Sandbox
reports and exports stay isolated and visibly identify test output.

## Monitoring and backups

New Relic transactions, correlated logs, and noticed errors retain context,
tenant/mode/space/generation, and payment-policy attributes. Public/account
requests do not pretend to have a business scope. Production business alerts
must exclude Sandbox; infrastructure availability and migrations must not be
filtered to business traffic. Monitor cleanup failures separately and retain
reset/purge control-plane audit after retired evidence is removed. Never log
credentials, signing keys, raw QRIS, codes, or connection strings.

Infrastructure backups are **operator-only full shared-database recovery copies**
containing all tenants and both modes. Encrypt/restrict backups and restore
environments. Report exports are not database backups. Do not distribute raw
snapshots to staff or sanitize the live database. Tenant-specific backup delivery
and deletion are outside this release.

## Local verification record — 2026-09-13

The implemented two-role/shared-access and real-value Sandbox changes passed:

- Complete backend `go test ./... -count=1` with PostgreSQL enabled. Integration
  tests create disposable schemas, including the populated pre-migration fixture,
  legacy signed queue/policy compatibility, account/session lifecycle races,
  global management, tenant isolation, and Sandbox lifecycle tests.
- `go vet ./...`.
- Complete backend `go test -race ./... -count=1`, with PostgreSQL enabled and
  no skipped tests.
- Mobile Jest: **43 suites, 290 tests**, plus TypeScript and Expo ESLint.
- OpenAPI validation, generated TypeScript client drift/type/lint checks, and Go
  regeneration with unchanged hashes for all seven generated files. The 22
  non-blocking OpenAPI warnings concern intentionally retired endpoints without
  success responses (16) and retained unused compatibility envelopes (6).
- Fresh Expo Android bundle export and offline ARM64 `assembleDebug` with
  Temurin JDK 21. The debug APK is not a signed release or a device acceptance test.
- `git diff --check`.

The final login regression checks cover password recovery between password
verification and session creation: issuance rechecks the verified credential
snapshot under the account lock before committing a session. Mobile regression
checks also cover stale session persistence, immediate access-change quarantine,
and policy-aware conflict replacements without modifying original signed evidence.

The race-detector run also exposed shared mutable connection metadata in the
[New Relic pgx tracer](https://github.com/newrelic/go-agent/blob/master/v3/integrations/nrpgx5/nrpgx5.go).
The pool now creates a tracer for each connection through `BeforeConnect`.
Query/batch instrumentation stays enabled, and query parameters remain excluded.

These results do **not** replace a production-data restore rehearsal, an
installed-device upgrade retaining encrypted data/queues, real shared-device
Bluetooth/integrated MPOS printing at both widths, approved merchant payment
reconciliation, or live New Relic acceptance. No production migration, payment,
device installation, deployment, or release was performed by these checks.

## Release acceptance gates

These are required gates, not claims of completed physical/production testing.

- Rehearse populated migration and privilege mapping, including disabled users,
  unchanged IDs/revisions/payments, encrypted storage, and exact signed queues.
- Verify two global roles across existing/new tenants; Admin ownership limits,
  Superadmin powers, tenant isolation, scoped stores/keys/QRIS/reports/cursors,
  idempotency, and independent Sandbox reset/purge.
- Test staff creation/forced password changes, global role/status/reset revocation,
  self/last-Superadmin guards, removed invitations, and rejected legacy account
  administration without unintended global mutations.
- Race access changes, suspension, enrollment revocation, and Sandbox reset with
  writes. Administration advisory locking precedes account locks; resource order
  remains account → tenant → membership → space → operation.
- Exercise pending work, interrupted switching/upgrades, offline/restart/logout,
  background sync, in-progress physical printing, quarantine, and exact-origin
  recovery. Another staff login must not replay someone else's evidence.
- Decode multi-total/multi-merchant Sandbox QRIS and unchanged Production QRIS;
  verify CRC, legacy Rp1.000 queues/reprints, real-payment warnings, and history.
  Automated tests use synthetic fixtures and must not send merchant payments.
- Compare preview/simulator/physical output at both widths, copy labels, profile
  snapshots, watermarks, failures, and switching during printing.
- Run disposable-schema PostgreSQL tests, mobile tests, generated-contract checks,
  and Android build using JDK 21. Finish installed-device upgrades, shared-device Bluetooth/
  integrated MPOS testing, production-restore rehearsal, live New Relic validation,
  merchant reconciliation testing, and explicit release approval before rollout.
