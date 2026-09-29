# Telomoyo POS

Android-first, local-first point of sale for Pengelola Wisata Telomoyo business units with
multiple physical terminals. The mobile app remains usable through connectivity
loss; PostgreSQL is the durable source of truth and Redis is disposable cache and
rate-limit infrastructure.

This repository is the v1 implementation foundation. Hardware-specific printer
acceptance still depends on the target MPOS model and vendor SDK.

## V1 product boundary

V1 records package quantities, immutable price/name snapshots, a cash-or-QRIS
payment method, and revision-bound pending/success/failed payment state. QRIS
compatibility mode derives an amount-specific code from a configured static
merchant payload; settlement is confirmed manually until an official payment
provider callback is integrated. V1 does not model motorcycle inventory,
customers, rental schedules, tax, shifts, photos, targets, or cancellations.

- Paket Standar: Rp70.000, canonical ID
  `00000000-0000-4000-8000-000000000001`
- Paket Sunrise: Rp100.000, canonical ID
  `00000000-0000-4000-8000-000000000002`
- Transaction persistence/API IDs are uppercase 26-character ULIDs. The UI and
  receipt add `TRX-`; that prefix is never stored.
- Money is whole rupiah and reporting uses `Asia/Jakarta`; weeks begin Monday.
- Admins can create/read transactions, correct and confirm payment for their own
  transactions, view statistics/exports, read packages, and change their own
  password.
- Global Superadmins additionally manage staff, tenants, packages, merchant
  configuration, and terminal enrollment. They may correct or confirm payment
  for every transaction and perform online-only transaction deletion.
  Self-demotion/deactivation and removal of the final active Superadmin are
  forbidden. Accounts and tenants are retained rather than deleted.

## Repository

```text
apps/
  backend/       Go 1.26, Gin, GORM/pgx/sqlc, PostgreSQL, Redis, New Relic
  mobile/        Expo SDK 57 / React Native 0.86 Android app with Zustand
api/
  openapi.yaml   OpenAPI 3.1 source of truth
packages/
  api-client/    generated TypeScript paths plus typed fetch transport
  eslint-config/
  typescript-config/
compose.yaml     local PostgreSQL, Redis, and optional backend profile
```

The backend follows domain/use-case/port/adapter boundaries. GORM provides typed
repository reads and forward-only, versioned database migrations; explicit pgx
transactions retain exact control over serializable writes, advisory locks,
revisions, audit events, and sync idempotency. The mobile app uses Zustand for
live state, encrypted SQLite as its UI read model, SecureStore for secrets, a
signed FIFO outbox, and cursor-based pull synchronization.

The production deployment can optionally expose a first-class Sandbox Mode.
Server-owned data spaces and generations keep test transactions out of
production history, revenue, exports, audit streams, and sync cursors. Sandbox
is disabled by default; every signed-in staff member can switch modes, while
only a production-mode global Superadmin can reset the selected tenant's shared Sandbox
generation.

## Multi-tenant operation

The migrated installation is the **Telomoyo** tenant. Existing accounts, IDs,
encrypted databases, terminal keys, and already-signed queues are preserved.
Every active account can enter every active business with the same global
Admin/Superadmin role, without invitations. Each business owns its catalog,
transactions, terminals, merchant QRIS, receipt identity, and Sandbox lifecycle.
Account context hosts global management and has no business-data access.

Provisioning is disabled by default (`TENANT_PROVISIONING_ENABLED=false`).
Do not enable it until the tenant-aware backend and compatible mobile app are
deployed and every old backend replica has stopped. The rollout, operator
commands, compatibility boundaries, and release acceptance checklist are in
[the multi-tenant operations guide](docs/multi-tenant-operations.md).

Superadmins manage tenants and global staff accounts in the mobile app. New
tenants are immediately active; new/reset passwords require a password change.
Role/status changes and password recovery revoke all account sessions. The
separate platform permission and invitation flows are removed. Operator recovery
is explicitly authorized and audited; tenant/account deletion is unavailable.

In Settings, **Bisnis & tenant** provides **Ganti bisnis**, **Kelola tenant**,
and **Identitas struk** according to role. The persistent business label also
opens the chooser. Superadmins enroll each physical installation separately in
each business; Admins can then use its existing enrollment. Switching keeps
tenant keys/caches separate and waits for queued synchronization and printing.

## Rebrand compatibility

`Telomoyo POS` is the public product name. Existing technical identifiers keep
their original `sewa-motor` values so this release upgrades the installed app
without losing encrypted databases, sessions, terminal enrollment, Docker
volumes, Redis keys, migration locks, or New Relic history. This includes the
application ID, Expo slug and scheme, workspace package names, Go module path,
SQLite filenames, SecureStore keys, Compose project name, and infrastructure
names.

The merchant name shown in QRIS is signed into the uploaded acquirer-issued
payload and is not application branding. Changing that name requires a newly
issued QRIS payload; the app never rewrites it.

## Prerequisites

- Node.js 22
- pnpm 9.0.0
- Go 1.26
- Docker with Compose
- JDK 21 and Android SDK for the verified Android development-build workflow
- EAS access for signed preview/production Android artifacts

Expo Go cannot load SQLCipher or the local Kotlin printer module. Use an Expo
development build from the beginning.

## Local setup

```sh
cp .env.example .env
pnpm install
pnpm infra:up
pnpm dev
```

`pnpm infra:up` starts only PostgreSQL and Redis. To build and run the backend
container as well:

```sh
pnpm infra:app
```

The default passwords and peppers are development-only. Never reuse them in a
deployed environment. Bootstrap reads an uncommitted manifest from `secrets/`;
every initial/reset password must be temporary and changed on first login.

New Relic is disabled locally by default. To enable it, set
`NEW_RELIC_ENABLED=true`, `NEW_RELIC_LICENSE_KEY`, and a deployment-specific
`NEW_RELIC_APP_NAME`. Never commit the license key.

The Android emulator reaches a host backend through
`http://10.0.2.2:8080/api/v1`. A physical MPOS must use an address reachable from
that device.

For a development-build print timing check, start Metro with
`EXPO_PUBLIC_PRINT_TIMING=true pnpm --filter @sewa-motor/mobile start`.
The `[print-timing]` messages report elapsed time from tap to configuration,
durable attempt recording, connection, printer-driver return, disconnect,
durable result recording, and UI readiness. They contain no receipt or customer
data. Compare repeated runs on the same device and receipt; note the first
paper movement separately because a driver return does not prove the paper has
finished. Do not reduce Bluetooth pacing or settle delays unless the final
line and cut remain complete on hardware. The checked-in `Printer MPOS` native
adapter is a placeholder, so an APK built from this checkout must not replace
a working MPOS installation until its vendor driver is recovered.

## Common commands

| Command                                            | Purpose                                     |
| -------------------------------------------------- | ------------------------------------------- |
| `pnpm dev`                                         | Run workspace development tasks             |
| `pnpm build`                                       | Build every workspace                       |
| `pnpm lint`                                        | Lint TypeScript and vet Go                  |
| `pnpm check-types`                                 | Check TypeScript and compile-check Go       |
| `pnpm test`                                        | Run workspace tests                         |
| `pnpm generate`                                    | Regenerate OpenAPI/sqlc artifacts           |
| `pnpm generate:check`                              | Fail when committed generated code is stale |
| `pnpm --filter @sewa-motor/mobile native:prebuild` | Generate the Android native project         |
| `pnpm openapi:lint`                                | Validate the public contract                |
| `pnpm compose:config`                              | Validate Compose interpolation and syntax   |
| `pnpm validate:foundation`                         | Check OpenAPI, generated drift, and Compose |
| `pnpm format:check`                                | Check repository formatting                 |

## API and synchronization contract

[`api/openapi.yaml`](api/openapi.yaml) is authoritative. JSON success responses
use `{data, meta}` and errors use
`{error: {code, message, details, requestId}}`; binary XLSX/PDF downloads are the
only exception.

The contract covers authentication/profile, users, packages, transactions and
revisions, print attempts, dashboard statistics, exports, terminal enrollment,
sync push/pull, and health/readiness. Do not hand-edit
`packages/api-client/src/generated/schema.ts`.

A signed sync operation has a UUID `operationId`, explicit `aggregateId`, origin
session/actor, server terminal UUID, client time, payload, and Base64 Ed25519
signature. The signature covers exactly `SyncMutationSignedBody` after RFC 8785
canonicalization; `baseRevision` must be present as `null` for creates.
Duplicates replay the stored result. Stale corrections return a revision conflict
with local and server snapshots.

## Infrastructure and release inputs

Compose is for development and CI. Production requires managed credentials,
TLS, backups, restore rehearsal, monitoring, and a deliberate GORM migration
step. Redis loss must only affect cache/rate limiting, never correctness.

Sandbox rollout is fail-closed: apply its schema/backfill-only GORM migration
with `SANDBOX_ENABLED=false`, deploy the scope-aware backend and compatible
mobile build, confirm no old backend replicas remain, verify production queries
and New Relic alerts use `data.mode = 'production'`, and only then enable it.
Enabling Sandbox performs an advisory-locked, idempotent generation activation
and package clone before the API starts accepting traffic; activation failure
stops startup. Cleanup failures never affect production readiness. Protocol-v3
Sandbox QRIS uses the full Sandbox package total and the real merchant payload,
so test transfers require manual reconciliation. Legacy origin sessions retain
their Rp1.000 policy and historical payments/reprints. Drain their outbox before
upgrading the session; never rewrite signed queues.

Infrastructure backups are operator-only full shared-database recovery copies
containing every tenant and both modes. Encrypt and restrict them and rehearse
restores. Never distribute a raw snapshot to staff or sanitize live data.

The backend Dockerfile exposes separate `migrate`, `bootstrap-superadmin`,
`bootstrap`, `account-admin`, and `api` targets. Production should run the
migration image as a one-shot pre-deploy step, run account provisioning only
when explicitly authorized, and deploy the API image without administrative
binaries.

For an installation hosted on Railway, follow
[Railway production: first Superadmin and recovery](apps/backend/README.md#railway-production-first-superadmin-and-recovery).
The guide selects the production database explicitly, keeps credentials out of
command arguments, and distinguishes initial provisioning from recovery of an
existing account. Do not run the development `pnpm seed:superadmin` command or
change `APP_ENV` to `development` against production.

The Android application ID is configured as
`com.fahmialfareza.sewamotorpos`. The following release inputs remain
intentionally unset:

- Expo/Play owner and account assignments
- backend hosting/domain and TLS termination
- initial production Superadmin identity and securely delivered temporary password
- MPOS model/OS, paper widths, Bluetooth capabilities
- vendor printer SDK/AAR/JAR and license
- internal tester list

Production release requires a Play Internal Testing AAB, physical acceptance on
each supported MPOS/printer combination, successful backup restore, and no
unexplained transaction loss or duplication.
