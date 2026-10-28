# Security audit: 28 Oct 2026

- **Tool:** Cloudflare `security-audit` skill (`.agents/skills/security-audit`), `quick` profile, static source review only.
- **Next audit:** 1 Dec 2026

This repository is public, so this file lists only the outcome. Full details are kept in the maintainer's private audit notes.

## Outcome

- No confirmed vulnerabilities.
- Two leads were reviewed and accepted as intended behaviour. They are documented in `docs/multi-tenant-operations.md` ("Accepted risks and intended behavior") and in `api/openapi.yaml` (`8d65529`):
  - terminal revocation semantics;
  - sales using superseded package prices.
