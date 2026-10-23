# PostgreSQL Backup

Automated weekly backups run every Saturday at 17:00 UTC (Sunday 00:00 WIB) via GitHub Actions and are stored in Cloudflare R2.

The workflow installs `postgresql-client-18`; `pg_dump` must be the same major version as the server or newer, so it works against PostgreSQL 17 and 18.

## Setup

Add the following secrets to the GitHub repository under **Settings → Secrets and variables → Actions**:

| Secret                 | Description                                                                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RAILWAY_DATABASE_URL` | Public connection string for the production database: the Postgres service's `DATABASE_PUBLIC_URL`, pointing at the telomoyo-pos database. A `*.railway.internal` host won't work. |
| `R2_ACCOUNT_ID`        | Cloudflare account ID (found in the R2 dashboard)                                                                                                                                 |
| `R2_BUCKET`            | R2 bucket name where backups are stored (`telomoyo-pos-database-backup`)                                                                                                         |
| `R2_ACCESS_KEY_ID`     | R2 API token access key ID                                                                                                                                                        |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret access key                                                                                                                                                    |

The R2 API token needs **Object Read & Write** permission on the target bucket.

Use a bucket dedicated to this project. Backups are written to the un-namespaced `postgres/weekly/` prefix, and the retention step deletes everything under it older than 28 days, so a bucket shared with other projects would mix and prune their backups too.

## Manual Run

Trigger a backup on demand from the GitHub Actions tab:

1. Open **Actions → PostgreSQL Weekly Backup**.
2. Click **Run workflow** → **Run workflow**.

## Restore

### Prerequisites

- `postgresql-client` 18 or newer installed locally (`pg_dump`, `pg_restore`).
- A target database URL you control.

### Steps

**Option A — restore from a local file:**

```bash
RESTORE_DATABASE_URL="postgresql://user:pass@host:5432/targetdb" \
  ./scripts/restore-postgres.sh path/to/backup-20260504T020012Z.dump.gz
```

**Option B — download from R2 first, then restore:**

```bash
# Configure AWS CLI with R2 credentials
aws configure

# Download the backup
aws s3 cp \
  "s3://<R2_BUCKET>/postgres/weekly/backup-20260504T020012Z.dump.gz" \
  ./backup.dump.gz \
  --endpoint-url "https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com"

# Restore
RESTORE_DATABASE_URL="postgresql://user:pass@host:5432/targetdb" \
  ./scripts/restore-postgres.sh ./backup.dump.gz
```

The restore script decompresses the archive and calls `pg_restore --clean --if-exists`, which drops existing objects before recreating them. Point it at a staging or development database to avoid touching production.

## Verification

After a restore, run a quick sanity check against the target database:

```bash
psql "$RESTORE_DATABASE_URL" -c "\dt"                                # list tables
psql "$RESTORE_DATABASE_URL" -c "SELECT COUNT(*) FROM data_spaces;"  # spot-check row count
```

To verify a backup file without restoring:

```bash
gunzip -c backup.dump.gz | pg_restore --list | head -40
```

## Backup Location

Backups are stored at:

```
s3://<R2_BUCKET>/postgres/weekly/backup-<YYYYMMDDTHHMMSSZ>.dump.gz
```

The workflow deletes backups older than 28 days after each run.
