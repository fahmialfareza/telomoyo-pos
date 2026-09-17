import type { SQLiteDatabase } from "expo-sqlite";

interface Migration {
  version: number;
  name: string;
  sql: string;
  legacyOnlySql?: string;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: "local_first_foundation",
    sql: `
      CREATE TABLE IF NOT EXISTS packages_local (
        id TEXT PRIMARY KEY NOT NULL,
        revision INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        unit_price INTEGER NOT NULL CHECK(unit_price >= 0),
        accent TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        deleted_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        occurred_at TEXT NOT NULL,
        subtotal INTEGER NOT NULL CHECK(subtotal >= 0),
        total INTEGER NOT NULL CHECK(total >= 0),
        origin_actor_id TEXT NOT NULL,
        origin_actor_name TEXT NOT NULL,
        updated_actor_name TEXT NOT NULL,
        terminal_id TEXT NOT NULL,
        sync_state TEXT NOT NULL,
        print_state TEXT NOT NULL,
        deleted_at TEXT,
        server_updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS transactions_occurred_at_idx
        ON transactions(occurred_at DESC);
      CREATE INDEX IF NOT EXISTS transactions_sync_state_idx
        ON transactions(sync_state);

      CREATE TABLE IF NOT EXISTS transaction_items (
        id TEXT PRIMARY KEY NOT NULL,
        transaction_id TEXT NOT NULL REFERENCES transactions(id),
        revision INTEGER NOT NULL,
        package_id TEXT NOT NULL,
        package_revision INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        accent TEXT NOT NULL DEFAULT 'primary',
        unit_price INTEGER NOT NULL,
        quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 999),
        line_total INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS transaction_items_transaction_idx
        ON transaction_items(transaction_id, revision);

      CREATE TABLE IF NOT EXISTS transaction_revisions (
        transaction_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        reason TEXT,
        before_json TEXT,
        after_json TEXT NOT NULL,
        origin_actor_id TEXT NOT NULL,
        submitting_actor_id TEXT NOT NULL,
        submitting_actor_name TEXT NOT NULL,
        terminal_id TEXT NOT NULL,
        client_occurred_at TEXT NOT NULL,
        server_received_at TEXT,
        PRIMARY KEY(transaction_id, revision)
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        terminal_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS outbox_operations (
        operation_id TEXT PRIMARY KEY NOT NULL,
        aggregate TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        action TEXT NOT NULL,
        base_revision INTEGER,
        operation_json TEXT NOT NULL,
        signature TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        next_attempt_at TEXT,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outbox_state_order_idx
        ON outbox_operations(state, occurred_at);

      CREATE TABLE IF NOT EXISTS print_attempts (
        id TEXT PRIMARY KEY NOT NULL,
        transaction_id TEXT NOT NULL,
        adapter TEXT NOT NULL,
        is_copy INTEGER NOT NULL DEFAULT 0,
        requested_at TEXT NOT NULL,
        completed_at TEXT,
        result TEXT NOT NULL,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS sync_conflicts (
        id TEXT PRIMARY KEY NOT NULL,
        transaction_id TEXT NOT NULL,
        local_json TEXT NOT NULL,
        server_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        resolution TEXT
      );

      CREATE TABLE IF NOT EXISTS sync_metadata (
        singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton = 1),
        cursor TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        last_synced_at TEXT,
        last_error TEXT
      );
      INSERT OR IGNORE INTO sync_metadata(singleton, status)
        VALUES(1, 'idle');
    `,
    legacyOnlySql: `
      INSERT OR IGNORE INTO packages_local(
        id, revision, name, description, unit_price, accent, active, updated_at
      ) VALUES
        ('00000000-0000-4000-8000-000000000001', 1, 'Paket Standar', 'Paket sewa motor standar', 70000, 'standard', 1, '2026-01-01T00:00:00.000Z'),
        ('00000000-0000-4000-8000-000000000002', 1, 'Paket Sunrise', 'Paket sewa motor sunrise', 100000, 'sunrise', 1, '2026-01-01T00:00:00.000Z');
    `,
  },
  {
    version: 2,
    name: "cache_all_sync_aggregates",
    sql: `
      CREATE TABLE IF NOT EXISTS synced_entities (
        aggregate TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        payload_json TEXT,
        deleted_at TEXT,
        changed_at TEXT NOT NULL,
        PRIMARY KEY(aggregate, aggregate_id)
      );
      CREATE INDEX IF NOT EXISTS synced_entities_changed_at_idx
        ON synced_entities(aggregate, changed_at DESC);
    `,
  },
  {
    version: 3,
    name: "deduplicate_transaction_items",
    sql: `
      DELETE FROM transaction_items
      WHERE rowid NOT IN (
        SELECT MAX(rowid)
        FROM transaction_items
        GROUP BY transaction_id, revision, package_id, package_revision
      );

      CREATE UNIQUE INDEX IF NOT EXISTS transaction_items_package_revision_unique_idx
        ON transaction_items(
          transaction_id,
          revision,
          package_id,
          package_revision
      );
    `,
  },
  {
    version: 4,
    name: "add_transaction_payment_state",
    sql: `
      ALTER TABLE transactions
        ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'legacy'
        CHECK(payment_method IN ('cash', 'qris', 'legacy'));
      ALTER TABLE transactions
        ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'pending'
        CHECK(payment_status IN ('pending', 'success', 'failed'));
      ALTER TABLE transactions
        ADD COLUMN payment_confirmed_revision INTEGER;

      UPDATE transactions
      SET payment_method = 'legacy',
          payment_status = 'success',
          payment_confirmed_revision = revision;

      CREATE INDEX IF NOT EXISTS transactions_payment_status_idx
        ON transactions(payment_status);
    `,
  },
  {
    version: 5,
    name: "preserve_print_revision_and_outbox_dependencies",
    sql: `
      ALTER TABLE print_attempts
        ADD COLUMN transaction_revision INTEGER;

      UPDATE transactions
      SET print_state = 'unknown'
      WHERE id IN (
        SELECT transaction_id
        FROM print_attempts
        WHERE result = 'pending'
          AND transaction_revision IS NULL
      );

      UPDATE print_attempts
      SET result = 'unknown',
          completed_at = COALESCE(completed_at, requested_at),
          error = COALESCE(
            error,
            'Revisi cetak lama tidak tersedia setelah pemutakhiran aplikasi.'
          )
      WHERE result = 'pending'
        AND transaction_revision IS NULL;

      ALTER TABLE outbox_operations
        ADD COLUMN dependency_key TEXT;

      UPDATE outbox_operations
      SET dependency_key = CASE
        WHEN aggregate = 'print_attempt'
          THEN COALESCE(
            json_extract(operation_json, '$.payload.transactionId'),
            aggregate_id
          )
        ELSE aggregate_id
      END
      WHERE dependency_key IS NULL;

      CREATE INDEX IF NOT EXISTS outbox_dependency_order_idx
        ON outbox_operations(dependency_key);
    `,
  },
  {
    version: 6,
    name: "quarantine_terminal_outbox_dependencies",
    sql: `
      UPDATE outbox_operations
      SET state = 'resolved',
          last_error = NULL,
          next_attempt_at = NULL
      WHERE state = 'discarded'
        AND last_error = 'REVISION_CONFLICT'
        AND EXISTS (
          SELECT 1
          FROM sync_conflicts
          WHERE sync_conflicts.transaction_id =
                outbox_operations.dependency_key
            AND sync_conflicts.resolved_at IS NOT NULL
        );

      UPDATE outbox_operations
      SET state = 'rejected'
      WHERE state = 'discarded'
        AND last_error IS NOT NULL;

      UPDATE outbox_operations AS successor
      SET state = 'rejected',
          attempts = attempts + 1,
          last_error = COALESCE(
            last_error,
            'Operasi dikarantina karena operasi sebelumnya belum dipulihkan.'
          ),
          next_attempt_at = NULL
      WHERE successor.state IN ('pending', 'error')
        AND EXISTS (
          SELECT 1
          FROM outbox_operations predecessor
          WHERE predecessor.dependency_key = successor.dependency_key
            AND predecessor.rowid < successor.rowid
            AND predecessor.state IN ('conflict', 'rejected')
        );

      UPDATE transactions
      SET payment_status = 'pending',
          payment_confirmed_revision = NULL,
          sync_state = CASE
            WHEN EXISTS (
              SELECT 1
              FROM outbox_operations blocked
              WHERE blocked.dependency_key = transactions.id
                AND blocked.state = 'conflict'
            ) THEN 'conflict'
            ELSE 'error'
          END
      WHERE EXISTS (
        SELECT 1
        FROM outbox_operations blocked
        WHERE blocked.dependency_key = transactions.id
          AND blocked.aggregate = 'transaction'
          AND blocked.state IN ('conflict', 'rejected')
      );
    `,
  },
  {
    version: 7,
    name: "normalize_transaction_timestamps_to_utc",
    sql: `
      UPDATE transactions
      SET occurred_at = strftime(
        '%Y-%m-%dT%H:%M:%fZ',
        occurred_at
      )
      WHERE strftime('%s', occurred_at) IS NOT NULL;
    `,
  },
  {
    version: 8,
    name: "bind_qris_payload_to_transaction_revision",
    sql: `
      ALTER TABLE transactions
        ADD COLUMN qris_payload_hash TEXT
        CHECK(
          qris_payload_hash IS NULL
          OR (
            length(qris_payload_hash) = 64
            AND qris_payload_hash = lower(qris_payload_hash)
            AND qris_payload_hash NOT GLOB '*[^0-9a-f]*'
          )
        );
    `,
  },
  {
    version: 9,
    name: "sandbox_generation_and_payment_amount",
    sql: `
      ALTER TABLE transactions
        ADD COLUMN payment_amount INTEGER NOT NULL DEFAULT 0
        CHECK(payment_amount >= 0);

      UPDATE transactions
      SET payment_amount = total;

      ALTER TABLE sync_metadata
        ADD COLUMN generation INTEGER;
    `,
  },
  {
    version: 10,
    name: "tenant_cache_and_quarantined_outbox",
    sql: `
      CREATE TABLE IF NOT EXISTS tenant_configuration (
        kind TEXT PRIMARY KEY NOT NULL,
        payload_json TEXT NOT NULL
      );
      ALTER TABLE outbox_operations ADD COLUMN quarantine_reason TEXT;
      ALTER TABLE transactions ADD COLUMN receipt_identity_json TEXT;
      CREATE TABLE IF NOT EXISTS scope_access (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        blocked_reason TEXT,
        blocked_actor_id TEXT,
        blocked_at TEXT
      );
      INSERT OR IGNORE INTO scope_access(singleton) VALUES (1);
    `,
  },
  {
    version: 11,
    name: "payments_auto_confirmed_at_creation",
    sql: `
      UPDATE transactions
      SET payment_status = 'success',
          payment_confirmed_revision = revision
      WHERE payment_status <> 'success';
    `,
  },
];

export async function runMigrations(
  database: SQLiteDatabase,
  options = { seedLegacyCatalog: true },
): Promise<void> {
  const row = await database.getFirstAsync<{ user_version: number }>(
    "PRAGMA user_version",
  );
  let currentVersion = row?.user_version ?? 0;

  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;
    await database.withTransactionAsync(async () => {
      await database.execAsync(migration.sql);
      if (options.seedLegacyCatalog && migration.legacyOnlySql)
        await database.execAsync(migration.legacyOnlySql);
      await database.execAsync(`PRAGMA user_version = ${migration.version}`);
    });
    currentVersion = migration.version;
  }
}

export const latestMigrationVersion =
  migrations[migrations.length - 1]?.version ?? 0;
