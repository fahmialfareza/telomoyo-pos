# Security audit: 28 Oct 2026

- **Tool:** Cloudflare `security-audit` skill (`.agents/skills/security-audit`), `quick` profile, static source review only (no target code executed).
- **Full report (local, outside the repo):** `~/security-audit-skill/telomoyo-pos/run-1/` (`findings.json`, `NEEDS-VALIDATION.md`, `coverage-ledger.json`). The run ended `incomplete` only because helpers could not write `REPORT.md`; both validators passed.
- **Next audit:** 1 Dec 2026 (see the end of this file)

## Results

| Verdict | Count |
|---|---|
| Confirmed | 0 |
| Needs validation | 2 (both decided as intended behaviour) |

**Held up well:**
- Store data is separated between stores.
- Admin and Superadmin checks are present.
- Prices are calculated on the server.
- Sync is signed and can't be replayed.
- Exports can't inject spreadsheet formulas.

## Decisions (28 Oct)

Both leads are accepted as intended behaviour. They are documented in `docs/multi-tenant-operations.md` under "Accepted risks and intended behavior" and in `api/openapi.yaml` (`8d65529`):

1. **Revoking a terminal** ends its device-bound sessions, but the account can still switch context and get a new session (`tenancy_control.go`). To fully cut off a lost device, reset the account's password or deactivate it.
2. **Sales may use superseded or deleted package prices** (`transactions.go`), so offline devices with a stale catalog can still sync.

## Open follow-ups (hardening)

- Sessions never expire; they end only when revoked.
- Login rate limiting turns off when Redis is missing or erroring.
- Weekly R2 backups aren't encrypted, although the README says they should be.
- Not checked: whether the mobile app switches context by itself after its terminal is revoked.

## Next audit: 1 Dec 2026

- **Profile:** run `standard`. The skill picks up `run-1`'s ledger from `~/security-audit-skill/telomoyo-pos/` and writes `run-2`.
- **Cover the areas this quick run skipped:**
  - mobile deep links;
  - mobile token storage and Android backup;
  - the Sandbox reset;
  - the operator command-line tools;
  - the Bluetooth printer module.
- **Run with independent helper agents** this time; on 28 Oct the audit did every step itself because of the 20-agent cap.
