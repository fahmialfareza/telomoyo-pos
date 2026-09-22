# Telomoyo POS Backend

Go 1.26 and Gin service for the local-first Telomoyo POS app.
PostgreSQL is the source of truth. GORM provides typed, context-aware repository
reads. Explicit pgx transactions remain in the atomic mutation paths that need
serializable isolation, advisory locks, append-only revisions, audit events, and
sync idempotency. Redis is optional and is used only for login rate limiting and
the immutable token-hash-to-session-ID cache; every authorization decision is
revalidated against PostgreSQL.

## Run locally

From the repository root:

```sh
docker compose up -d postgres redis
pnpm --filter @sewa-motor/backend run dev
```

The default Compose environment enables automatic migrations. Without Compose:

```sh
cp apps/backend/.env.example apps/backend/.env
DATABASE_URL='postgres://sewa_motor:sewa_motor@localhost:5432/sewa_motor?sslmode=disable' \
  go run ./apps/backend/cmd/migrate
```

Health endpoints are available at `/api/v1/health/live` and
`/api/v1/health/ready`, with `/healthz` and `/readyz` aliases for hosting
platforms. `/readyz` (and `/api/v1/health/ready`) ping PostgreSQL, so point
hosting healthchecks there; `/healthz` always returns 200 and only reports
Redis status.

## Cold starts on serverless databases (Railway)

PostgreSQL/Redis on serverless plans may sleep through a deploy or cold start.
Startup therefore retries the initial Postgres connection and the GORM
migrations with capped exponential backoff and full jitter, controlled by:

```dotenv
DB_CONNECT_MAX_ATTEMPTS=10   # minimum 1
DB_CONNECT_MAX_BACKOFF=60s   # minimum 1s; per-attempt dial timeout is 15s
```

The Redis client gets explicit dial/retry budgets (`DialTimeout` 5s,
`MaxRetries` 5, retry backoff 200ms–2s); while Redis is unreachable its errors
degrade to cache-miss/allow so PostgreSQL stays the source of truth. Configure
the Railway healthcheck against `/readyz` so traffic only arrives after
Postgres is reachable.

If PostgreSQL sleeps after startup, protected requests preserve connection and
timeout failures as `INTERNAL_ERROR` instead of reporting a valid session as
`UNAUTHORIZED`. Mobile keeps its encrypted session and retries through its
normal foreground, reconnect, periodic, or manual synchronization paths.

## Public privacy and account-deletion pages

The API also serves two public Indonesian HTML pages, without login or a
separate frontend:

- `/privacy-policy` — privacy policy, processing disclosures, and contact.
- `/account-deletion` — instructions and an email link to request account and
  associated-data deletion without reinstalling or signing into the app.

Both pages and their stylesheet are embedded in the Go binary, so the existing
distroless image needs no extra files or Dockerfile changes. Their handlers do
not query PostgreSQL/Redis or authenticate a session. The API still follows its
normal startup requirements. Requests retain the existing logging and New Relic
middleware. GET and HEAD are supported; these are not JSON API mutation routes.

In Railway's **API service → Variables**, set:

```dotenv
PRIVACY_OPERATOR_NAME="Pengelola Wisata Telomoyo"
PRIVACY_CONTACT_EMAIL=your-real-monitored-mailbox
```

Replace `your-real-monitored-mailbox` with a real, monitored email address (no
`mailto:` prefix or display name). Do not publish the placeholder above. Operator
name defaults to Pengelola Wisata Telomoyo. An omitted/blank email keeps existing
API deployments working, but both legal pages return **503** with a setup notice
and `noindex`; a nonempty malformed email is rejected at startup. A startup
warning identifies missing configuration without logging credentials.

Deploy the backend, then use your public HTTPS domain—not the internal Railway
hostname or a private/local IP—in Google Play Console:

| Console field                            | Public URL                                        |
| ---------------------------------------- | ------------------------------------------------- |
| Privacy policy                           | `https://YOUR-PUBLIC-API-DOMAIN/privacy-policy`   |
| Account and associated-data deletion URL | `https://YOUR-PUBLIC-API-DOMAIN/account-deletion` |

Replace the host with the API's generated Railway domain or its custom domain.
No `/api/v1` prefix is used. Keep these routes and `/legal/styles.css` publicly
accessible; do not put them behind authentication, geographic restrictions, or
an interactive proxy challenge. Serve production through HTTPS.

Check both URLs while signed out and confirm the actual mailbox is shown:

```sh
curl --fail --head https://YOUR-PUBLIC-API-DOMAIN/privacy-policy
curl --fail --head https://YOUR-PUBLIC-API-DOMAIN/account-deletion
```

Expect `200` and `Content-Type: text/html; charset=utf-8`, not a login screen or
JSON response. Open the pages in a browser, navigate between them, and test the
email link. It opens the user's email client with a subject; **the user must
send the email**. The backend does not accept/store requests, send mail, or
delete anything from these routes. No email-service credentials are needed.

Before Play submission, complete the
[publication and manual-request checklist](../../docs/google-play-privacy.md).
In particular, approve the actual retention/deletion process and provide the
in-app privacy/deletion links; publishing HTML alone is not an account-erasure
implementation or a guarantee of Google Play approval.

## Container targets

The Dockerfile produces separate non-root images so the serving image contains
only the API binary:

```sh
docker build --target api -t sewa-motor-backend:api apps/backend
docker build --target migrate -t sewa-motor-backend:migrate apps/backend
docker build --target bootstrap -t sewa-motor-backend:bootstrap apps/backend
docker build --target bootstrap-superadmin -t sewa-motor-backend:bootstrap-superadmin apps/backend
docker build --target account-admin -t sewa-motor-backend:account-admin apps/backend
```

The `api` target is the default for a plain `docker build` and is selected
explicitly by Compose. Run migrations as a one-shot step before deploying the
API, then set `AUTO_MIGRATE=false` on the production API container:

```sh
docker run --rm \
  --env DATABASE_URL='postgres://...' \
  sewa-motor-backend:migrate
```

Bootstrap remains a separate, manually authorized one-shot operation. Mount the
secret manifest read-only and ensure it is readable by container UID 65532:

```sh
docker run --rm \
  --env DATABASE_URL='postgres://...' \
  --mount type=bind,src=/secure/path/bootstrap-users.json,dst=/run/secrets/bootstrap-users.json,readonly \
  sewa-motor-backend:bootstrap \
  -manifest /run/secrets/bootstrap-users.json
```

## Database migrations

Runtime migrations are forward-only Go migrations in `migrations/` and receive
the configured `*gorm.DB`. Each version runs atomically under a PostgreSQL
advisory lock. GORM `AutoMigrate` creates the base tables only inside an
unapplied version; deferred composite foreign keys, append-only triggers, and
other PostgreSQL-specific invariants are installed through the same GORM
transaction.

`sqlc/schema.sql` is a code-generation snapshot only. The backend never executes
that SQL file as a migration.

## Organization accounts and tenant scope

Exactly two global roles are authoritative: `admin` and `superadmin`. Every
active account may enter every active tenant without invitation or membership
approval; historical membership links remain for attribution and constraints.
Business APIs still derive tenant/data-space scope from the session, and
cross-tenant identifiers return `404`. Account context has no business access.

Account-context `/management/tenants`, `/management/users`, and
`/management/audit` require a global Superadmin. New tenants are directly active
with an empty catalog and initial receipt identity. Provisioning controls only
creation; names can change independently of receipt identity, IDs/slugs cannot,
and tenant deletion is unavailable. Global staff creation/recovery requires a
temporary-password change. Role changes, deactivation, and recovery revoke all
account sessions; self-demotion/deactivation and last-Superadmin removal are
blocked. Old invitation and membership-mutation routes fail explicitly instead
of becoming global account mutations.

Only a Production-mode Superadmin can enroll/revoke a terminal or change tenant
QRIS/receipt identity. Admins operate valid existing enrollments on shared
devices and retain ownership-limited correction/payment permissions. Sessions,
terminal keys, QRIS history, and signed queues stay tenant-scoped. See the
[operations guide](../../docs/multi-tenant-operations.md) for operator recovery,
safe switching/quarantine, migration rehearsal, and release gates.

## New Relic observability

Production configuration requires:

```sh
NEW_RELIC_ENABLED=true
NEW_RELIC_APP_NAME=sewa-motor-backend-production
NEW_RELIC_LICENSE_KEY=...
NEW_RELIC_DISTRIBUTED_TRACING_ENABLED=true
NEW_RELIC_LOG_FORWARDING_ENABLED=true
```

The `sewa-motor-backend-production` application name is intentionally retained
as a stable operational identifier so the Telomoyo POS rebrand does not split
APM history, dashboards, or alerts.

The Gin middleware creates a New Relic web transaction for every route. The
request context is propagated through use cases, GORM, pgx, and Redis, with
function-level segments for business and repository work. pgx and GORM emit
PostgreSQL datastore segments; Redis commands are instrumented as Redis
datastore segments so both appear under APM Databases. SQL query parameters
and Redis keys (session-index token hashes and rate-limit identifiers) are
excluded from telemetry. All API errors, rejected operations inside a
successful sync batch, database/cache failures, and recovered panics are
reported through `NoticeError`.

Logrus emits structured JSON. New Relic's Logrus logs-in-context formatter adds
trace/span correlation and forwards records through the Go agent when log
forwarding is enabled. Do not place session tokens, passwords, terminal private
keys, database URLs, or license keys in log fields.

Authenticated tenant requests carry session-authorized `auth.context`,
`tenant.id`, `data.mode`, `data.space_id`, generation, and payment-policy
attributes. Account/public requests do not claim a business data space. Sandbox
initializer and janitor work is separately classified. These attributes apply
to New Relic transactions, noticed errors, and correlated Logrus records.

Keep business alerts mode-specific. For example, a Production API error
condition and a separate non-revenue Sandbox error view can start from:

```sql
SELECT count(*) FROM TransactionError
WHERE appName = 'sewa-motor-backend-production'
  AND `data.mode` = 'production'
```

```sql
SELECT count(*) FROM TransactionError
WHERE appName = 'sewa-motor-backend-production'
  AND `data.mode` = 'sandbox'
FACET operation
```

Do not add a mode filter to fleet availability, process restart, telemetry
loss, or migration alerts: those failures can occur before a request has a data
scope. A `sandbox.initialize` error is a deployment/startup failure. Monitor
`sandbox.cleanup` separately and configure loss-of-signal on the following log
query while the API fleet is expected to be running. Use 36 hours for the
default 24-hour cleanup interval (and never exceed New Relic's 48-hour
loss-of-signal maximum):

```sql
SELECT count(*) FROM Log
WHERE `data.mode` = 'sandbox'
  AND message = 'sandbox cleanup completed'
```

Before enabling Sandbox, verify that web traffic is classified (the following
must remain zero), Production alerts exclude Sandbox, and the Sandbox error and
cleanup conditions actually receive a test signal:

```sql
SELECT count(*) FROM Transaction
WHERE appName = 'sewa-motor-backend-production'
  AND transactionType = 'Web'
  AND `auth.context` = 'tenant'
  AND `data.mode` IS NULL
```

## Production-hosted Sandbox Mode

Sandbox Mode is an isolated data space inside the production service, not a
replacement deployment environment. It is disabled by default:

```sh
SANDBOX_ENABLED=false
SANDBOX_RETENTION_DAYS=30
SANDBOX_QRIS_AMOUNT=1000
SANDBOX_CLEANUP_INTERVAL=24h
```

`SANDBOX_QRIS_AMOUNT=1000` is deprecated but accepted with a warning during
transition; it does not override new session policy. Protocol-v3 Sandbox QRIS
uses the full Sandbox package-price total, independently of Production prices,
and the tenant's real merchant payload. Transfers are real and require manual
payment confirmation/reconciliation. Screens, receipts, and exports remain
marked as test output.

Legacy sessions retain immutable `sandboxQrisPolicy=fixed_1000`. Signed mutation
amounts are derived from the validated origin session, not the submitting app.
Existing payments, QR codes, and reprints retain their stored amount. The new
client drains the old outbox online before `/auth/upgrade-session` negotiates
protocol 3 with `transaction_total`; failed upgrades must block new Sandbox
creates/corrections. Never rewrite or re-sign historical queues. Follow the
[internal operations guide](../../docs/multi-tenant-operations.md) for global-role
migration, compatible rollout, and rollback boundaries.

For first-time Sandbox activation, use the following sequence. An existing
installation upgrading to global roles/full-value Sandbox must first follow
the internal-organization rollout in the operations guide, including stopping
all incompatible replicas before applying migration `000006`.

1. Back up PostgreSQL and apply the forward-only GORM migration while
   `SANDBOX_ENABLED=false`. This migration only adds and backfills the data-space
   schema; it does not create, clone, or seed a Sandbox generation.
2. Deploy the scope-aware backend with Sandbox still disabled.
3. Release the compatible mobile build, then verify production dashboard,
   history, exports, and sync remain in the production data space.
4. Confirm that no pre-data-space backend replicas remain. Filter New Relic
   production alerts by `data.mode = 'production'` and create a separate
   Sandbox cleanup/error view.
5. Set `SANDBOX_ENABLED=true` and restart the API. Before accepting traffic,
   each replica runs an advisory-locked, idempotent activation; the first
   replica creates the generation and clones the then-current production
   packages, while the others reuse it. Any activation failure prevents that
   replica from starting.

`GET /sandbox/status` remains usable while the feature is disabled. It returns
the effective setting for the selected business; `dataSpaceId` and `generation`
are `null` only when Sandbox has never been activated. A previously activated
generation remains identified while entry is disabled, so clients can recognize
the state without assuming that retained data disappeared.

Switching mode is online-only, available to every signed-in staff member, and
rotates the session into the selected data space. Only a production-mode
superadmin may reset Sandbox. Reset advances the sandbox generation; the
retired generation stays append-only until its configured retention boundary
(30 days by default), after which cleanup removes it without affecting
production readiness. A Production-mode Superadmin can use
`PUT /sandbox/settings` to enable or disable the selected business. Disabling
blocks new Sandbox operations without revoking sessions or removing local/server
evidence, and affected clients can still rotate back to Production.

`SANDBOX_ENABLED` is the backward-compatible default for businesses that have
not yet been explicitly configured. Once a Superadmin saves a business setting,
that database value takes precedence over the environment variable.

### Backup and restore boundary

Infrastructure backups are operator-only recovery copies of the full shared
database: all tenants, Production and Sandbox, credentials, and audit history.
Encrypt and restrict snapshots, continuous archives, dumps, and restore
environments. Never distribute raw snapshots to staff; report exports are not
database backups. Tenant-specific backup delivery is outside this release.

Rehearse recovery in an isolated disposable database that no serving API or
device can reach. Compare tenant/account counts, immutable IDs, revisions,
payment amounts, QRIS bindings, sessions, and audit history against the captured
recovery point before testing migrations there. Keep recovered credentials
protected and prevent the rehearsal service from forwarding logs or acting on
real merchant/printer integrations. Never sanitize the live database or use
single-tenant filtering assumptions to remove other tenants' data.

Sandbox cleanup does not retroactively remove evidence from retained recovery
copies. Apply the operator's approved backup retention independently of the
30-day retired-generation cleanup. Only release a restore after its tenant and
payment-policy compatibility has been verified by an authorized operator.

## Bootstrap users

Bootstrap requires an uncommitted JSON secret containing exactly one
superadmin and seven admins. All passwords are temporary and every account is
forced to change its password before accessing POS features.

```json
{
  "users": [
    {
      "fullName": "Pemilik",
      "username": "pemilik",
      "role": "superadmin",
      "temporaryPassword": "replace-with-a-secret"
    }
  ]
}
```

The real manifest must contain eight entries and passwords of at least 12
characters. Keep it outside Git, then run:

```sh
DATABASE_URL='postgres://...' \
  go run ./apps/backend/cmd/bootstrap -manifest /secure/path/bootstrap-users.json
```

The command is idempotent by username and never silently resets an existing
password.

## Railway production: first Superadmin and recovery

Run account provisioning as an explicitly authorized, one-off operator task
from a trusted workstation. The deployed Distroless `api` image contains only
`/app/api`: it has no shell, Go toolchain, bootstrap, or account-admin binary.
An API start-command override or `railway ssh ... go run ...` will not provide
those tools. Do not add seeding to startup, every deployment, or a cron job.

The current commands serve different purposes:

| Situation                                       | Command                                       | Important boundary                                                                      |
| ----------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------- |
| First production Superadmin                     | `cmd/bootstrap-superadmin`                    | Creates one initial Superadmin; requires explicit confirmation and a password on stdin. |
| Optional original eight-person roster           | `cmd/bootstrap`                               | Requires exactly one Superadmin and seven Admins in a protected manifest.               |
| Existing active account needs Superadmin access | `cmd/account-admin --action grant-superadmin` | Changes the global role; does not create an account.                                    |
| Existing active account cannot sign in          | `cmd/account-admin --action reset-password`   | Revokes every account session and requires a new password at next login.                |
| Local development sample only                   | `pnpm seed:superadmin`                        | Requires `APP_ENV=development`; never use it against production.                        |

Use the single-account command for a new installation. Do not bypass the
development guard or create seven dummy Admins for the original roster command.

### 1. Verify the production target and database connection

Use the reviewed backend revision matching the deployed schema, Go 1.26, Node.js,
and the current [Railway CLI](https://docs.railway.com/cli). Before any write,
confirm an approved production backup exists and the versioned GORM migrations
have already succeeded, including `000006_internal_organization`. The production
account-provisioning and recovery commands do not run migrations automatically.

In Railway's dashboard, select the actual production environment and confirm
which PostgreSQL service the API references. Copy the project, environment, and
PostgreSQL service IDs, not the API service ID. Then, from the repository root:

```sh
railway login
railway --version
railway_project_id='replace-with-project-id'
railway_environment_id='replace-with-production-environment-id'
railway_postgres_service_id='replace-with-production-postgres-service-id'
```

`railway run` executes on **your computer**, with the selected service's
variables injected; it does not run inside the deployed container. The wrapper
below supplies all three IDs and `--no-local` to avoid linked-target or local
development overrides. [Railway run reference](https://docs.railway.com/cli/run)

For this workstation workflow, the PostgreSQL service must have approved public
TCP access and its `DATABASE_PUBLIC_URL`. A `*.railway.internal` address is not
directly reachable from your laptop; keep the API itself using its private
database URL. If public access is unavailable, stop and use an operator-approved
private-network execution/tunnel workflow; do not silently expose the database
or substitute your local database. Railway documents public database access
under PostgreSQL **Settings → Networking → Public Access**.
[PostgreSQL connectivity](https://docs.railway.com/databases/postgresql#connecting-externally),
[private networking](https://docs.railway.com/networking/private-networking).

### 2. Build and prepare the local operator

These commands build locally; they do not deploy or modify a database:

```sh
umask 077
operator_directory=$(mktemp -d "${TMPDIR:-/tmp}/telomoyo-operator.XXXXXX")
go build -o "$operator_directory/bootstrap-superadmin" ./apps/backend/cmd/bootstrap-superadmin
go build -o "$operator_directory/account-admin" ./apps/backend/cmd/account-admin
```

Define this helper in the same terminal. It fetches only the selected PostgreSQL
service's variables, fails when the public URL is missing, requires database
TLS (retaining an existing certificate-verifying mode), and passes the URL in
the child environment, never in command arguments or output. `APP_ENV` and
`AUTO_MIGRATE` here affect only the local operator process, not Railway settings.

```sh
railway_operator() {
  railway run \
    --project "$railway_project_id" \
    --environment "$railway_environment_id" \
    --service "$railway_postgres_service_id" \
    --no-local node -e '
      let url;
      try {
        url = new URL(process.env.DATABASE_PUBLIC_URL || "");
        if (!["postgres:", "postgresql:"].includes(url.protocol) ||
            !url.hostname || url.hostname.endsWith(".railway.internal")) {
          throw new Error();
        }
      } catch {
        console.error("An approved production DATABASE_PUBLIC_URL is required.");
        process.exit(1);
      }
      if (!["require", "verify-ca", "verify-full"].includes(url.searchParams.get("sslmode"))) {
        url.searchParams.set("sslmode", "require");
      }
      const result = require("node:child_process").spawnSync(
        process.argv[1], process.argv.slice(2), {
          env: { ...process.env, DATABASE_URL: url.toString(),
                 APP_ENV: "production", AUTO_MIGRATE: "false" },
          stdio: "inherit"
        }
      );
      if (result.error) console.error("Could not start the local operator binary.");
      process.exit(result.status ?? 1);
    ' "$@"
}
```

Do not enable shell tracing (`set -x`), print environment variables, paste the
database URL into commands, or share unredacted diagnostics. Keep password and
manifest files outside the repository in restricted storage. TLS `require`
encrypts the connection but does not verify the server hostname; use
`verify-full` with the approved CA/hostname configuration when available.

### 3. Create the first production Superadmin

In a secure editor, prepare a protected file containing only one unique random
temporary password on one line (8–256 bytes, without surrounding quotes; prefer
at least 12 characters). Keep the file outside the repository. Do not put the
password in shell commands, Git, or Railway deployment logs.

After reviewing the exact production target IDs, replace the account name,
operator identity, and reason below with the approved values, then run once:

```sh
initial_password_file='/absolute/protected/path/initial-superadmin-password.txt'
chmod 600 "$initial_password_file"
railway_operator "$operator_directory/bootstrap-superadmin" \
  --username telomoyo.owner --full-name 'Nama Pengelola Telomoyo' \
  --operator on-call@example.test --reason 'Approved initial production setup' \
  --confirm-production < "$initial_password_file"
```

The command creates one active global Superadmin, requires a first-login
password change, records an organization audit event with the operator/reason,
and publishes safe account projections. It prints no password. It refuses a
different existing Superadmin, an existing Admin under the requested username,
or an inactive/deleted or mismatched account. An exact existing active
Superadmin identity is an idempotent no-op; rerunning does **not** reset that
password, revive sessions, or reactivate an account.

Sign in online using the intended Superadmin and change the temporary password
before operating. Select the business and enroll the physical terminal as that
Superadmin. Subsequent staff creation belongs in **Pengguna** in the mobile app;
do not routinely rerun bootstrap. Transfer initial passwords through the approved
secret channel and remove the temporary password file from operator storage after
handoff according to your secret-retention policy.

### 4. Recover an existing account instead of reseeding

An existing active Admin can be explicitly promoted after operator authorization:

```sh
railway_operator "$operator_directory/account-admin" \
  --action grant-superadmin --username approved.account \
  --operator on-call@example.test --reason 'Approved organization Superadmin recovery'
```

Replace the account, operator identity, and reason with the approved values. A
role change revokes all of that account's sessions across tenants. Promotion
alone does not replace a password or set the forced-password-change flag.

For a forgotten password, use a protected file containing only the unique
temporary password on one line (8–256 bytes, without surrounding quotes). Create
it in a secure editor, then pass it through stdin:

```sh
recovery_password_file='/absolute/protected/path/temporary-password.txt'
chmod 600 "$recovery_password_file"
railway_operator "$operator_directory/account-admin" \
  --action reset-password --username approved.account \
  --operator on-call@example.test --reason 'Verified account-owner password recovery' \
  < "$recovery_password_file"
```

Recovery preserves the role, revokes all sessions, and requires changing the
temporary password after the next online login. Both operator actions append
audited `operator.*` events with the responsible operator and reason, never the
password. They cannot create, reactivate, or recover a deleted account. Neither
action alters signed offline evidence; preserve quarantined entries and follow
the [offline recovery procedure](../../docs/multi-tenant-operations.md#sessions-compatibility-and-offline-recovery).
Remove the temporary password file after secure handoff according to your secret
policy. Do not use SQL edits or development seeds as password-recovery shortcuts.

## Sample development superadmin

For local development, create one sample superadmin without weakening the
production eight-user bootstrap contract:

```sh
pnpm seed:superadmin
```

The command reads `apps/backend/.env`, requires `APP_ENV=development`, applies
pending GORM migrations, and creates `superadmin` / `Penyok`. If
`DEV_SUPERADMIN_PASSWORD` is empty, the development-only temporary password is
`superadmin123`. The seed is idempotent and never resets an existing password.
The account must change its password after its first login.

To explicitly replace the password of an existing sample account, revoke all
of its active sessions, and require another password change, run:

```sh
pnpm seed:superadmin --reset-password
```

The reset is transactional and records both an audit event and a sync change.
It is only available when `APP_ENV=development`; ordinary seed reruns remain
non-mutating.

## Generated contracts

The authoritative OpenAPI 3.1 contract is at `../../api/openapi.yaml`. Code
generation creates a deterministic OpenAPI 3.0 compatibility view for
oapi-codegen and generates sqlc query types:

```sh
pnpm --filter @sewa-motor/backend run generate
pnpm --filter @sewa-motor/backend run generate:check
```

## Signed synchronization

Each outbox operation is signed with its enrolled terminal Ed25519 key. The
signed object has exactly these fields:

```text
operationId, aggregate, aggregateId, action, baseRevision,
originSessionId, originActorId, terminalId, occurredAt, payload
```

`baseRevision` is always present and is `null` for creates. `occurredAt` is UTC
with exactly millisecond precision. The object is canonicalized using RFC 8785
and the signature is standard Base64. The `signature` property itself is not
signed.

Business mutation, audit event, sync change, and stored idempotency result are
committed in one PostgreSQL transaction. Retries with the same operation ID
replay the original success or deterministic conflict; reuse with another
payload is rejected.

## Verification

```sh
pnpm --filter @sewa-motor/backend run lint
pnpm --filter @sewa-motor/backend run test
pnpm --filter @sewa-motor/backend run build
```

The focused test suite covers Argon2id and opaque sessions, RFC 8785/Ed25519
golden vectors, transaction snapshot contracts, RBAC safeguards, sync replay
and conflict behavior, export artifacts, bootstrap validation, and HTTP
envelopes.
