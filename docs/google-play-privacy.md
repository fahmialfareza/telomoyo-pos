# Google Play privacy and account-deletion pages

The backend serves `/privacy-policy` and `/account-deletion` in Indonesian.
See [backend deployment instructions](../apps/backend/README.md#public-privacy-and-account-deletion-pages)
for Railway variables and public URLs. Templates live in
`apps/backend/internal/adapter/httpapi/pages/` and are embedded at build time.
Edit the copy and its fixed last-updated date together when policy changes are
approved; redeploy to publish changes. Sandbox retention text reads the backend
configuration, distinguishing new resets from historical retirement deadlines.

## Release checklist

- [ ] Confirm the operator/developer identity matches the real organization.
      The app name **Telomoyo POS** is explicitly present on both pages.
- [ ] Configure `PRIVACY_CONTACT_EMAIL` with a public mailbox monitored by the
      responsible operator. Confirm receiving and replying works; merely opening
      the `mailto:` link does not submit anything.
- [ ] Have the responsible operator review/approve the policy, including
      no-sale/no-advertising statements, hosting and New Relic disclosures, identity
      verification, request handling, and any legal retention exceptions. This is a
      draft based on application behavior, not legal advice or a compliance finding.
- [ ] Establish actual Production, account, monitoring, hosting-log, backup,
      and privacy-request retention periods and a request-response/completion
      process. The repository cannot verify these operational settings. Update the
      public copy with approved specifics; do not substitute Sandbox's retention
      period or invent a fixed response deadline.
- [ ] Confirm HTTPS on the public backend domain. Visit both URLs signed out
      and outside the store network, with no authentication or geographic gate.
      Both must return `200`, have readable mobile layouts, and show the real contact.
      A missing mailbox intentionally returns `503` and is **not** ready for Play.
- [ ] Enter the privacy URL in the privacy-policy field and the separate
      account-deletion URL in the applicable Data safety field.
- [ ] Expose accessible **Kebijakan Privasi** and **Minta penghapusan akun & data**
      links within the mobile app (including an account/settings path). This backend
      change does not add the mobile links. Ensure the URLs use the deployed public
      domain, not an emulator/LAN address.
- [ ] Complete Data safety declarations consistently with actual deployment,
      SDKs, permissions, and the reviewed privacy policy. “Internal app” or
      staff-only provisioning alone is not evidence of a Play policy exemption.
- [ ] Validate the manual deletion process can actually be fulfilled before
      claiming support in Play Console. Retained audit/transaction data needs a
      specific legitimate reason, not just an append-only implementation.

Google requires an accessible privacy policy in Play Console and within the
app, identifying data handling, contact, and retention/deletion practices.
[Google Play User Data policy](https://support.google.com/googleplay/android-developer/answer/10144311?hl=en).
Google documents email as one possible external deletion-request channel;
deactivation alone is not deletion, and retained data needs transparent reasons.
[Account deletion guidance](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en).
Requirements checked 15 September 2026; recheck when submitting.

## Manual request handling

The public page supplies a real contact channel, not an automated erasure API.
No form, request database, SMTP service, or destructive administrative command is
introduced. The existing application manages account status and revocation, not
end-to-end account erasure.

The responsible operator must establish a reviewed procedure before publication:

1. Receive the request through the configured mailbox. Limit access to authorized
   handlers and keep only the information needed to process it. Never request a
   password, OTP, bank PIN, or unnecessary identity documents.
2. Verify the requester against existing staff records without making app login
   or reinstallation mandatory. An email address alone is not proof of ownership:
   staff accounts use usernames, not verified email addresses.
3. Inventory the account's associated personal data across **all tenants and
   modes**, sessions, enrollment attribution, transaction/receipt snapshots,
   audit, sync evidence, encrypted device caches, providers, and backups.
4. Determine the permitted deletion/anonymization scope and any specific
   retention obligation. Explain retained categories, reason, duration, and the
   estimated completion time to the requester. Protect other people's data.
5. Arrange a separately reviewed, authorized erasure/anonymization operation
   and provider/device handling where required. **Do not disable append-only
   protections or run blanket deletes from these instructions.** No general
   account-erasure procedure currently exists in the backend. If one is needed,
   implement and rehearse it separately before promising completion.
6. Ensure recoverable backups and offline devices cannot silently restore
   removed information. Record justified minimal completion evidence, notify
   the requester of the actual result and any retained information, and apply
   the approved retention schedule to the correspondence itself.

Current implementation facts to preserve in future policy edits:

- Deactivation revokes sessions but retains the account and historical identity.
- Transaction deletion is a soft-delete; revisions/audit remain.
- Logout and invalid-session handling preserve/quarantine offline evidence.
- Sandbox cleanup removes only expired retired generations, not active Sandbox,
  Production, staff accounts, all lifecycle audit, or retained backups.
- Production data has no general automatic age-based purge. Backup and telemetry
  retention are controlled separately from the Sandbox janitor.
- QRIS images are decoded locally; saved merchant payloads are sent to the API.
  QRIS payments are confirmed manually, including real-money Sandbox payments.
- Camera/selected-image and Bluetooth permissions have functional uses. Android
  may require a location permission for Bluetooth; this is not a GPS-tracking
  feature. Review the final release manifest when completing Data safety.
- HTTP logging includes IP/request metadata. New Relic may receive traces,
  errors, and forwarded logs; do not describe all diagnostics as anonymous.

## Verification

From `apps/backend`:

```sh
go test ./internal/config ./internal/adapter/httpapi
go test ./...
go vet ./...
```

Tests cover public access without business dependencies or valid authentication,
HTML escaping, safe email links, contact validation, explicit missing-contact
responses, embedded CSS, GET/HEAD parity, security headers, and the absence of
public mutation/static-directory exposure. Browser/device review and a real
mailbox delivery check remain deployment tasks.

The initial implementation was also checked in local headless Chrome at 320,
390, 768, and 1280 CSS pixels: both documents and embedded styles loaded,
request links were present, no horizontal overflow was measured, and no page
console errors were recorded. Those local checks used a temporary sample
mailbox, not the production contact; they do not replace a delivery test.
