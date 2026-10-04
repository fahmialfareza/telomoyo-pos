import type { SQLiteDatabase } from "expo-sqlite";

// All writes to a scoped SQLite file share one opened database. Expo's
// withTransactionAsync issues BEGIN/COMMIT on that shared connection and can
// be interrupted by another transaction from foreground/background sync.
// Queue transaction admission per connection. Keep the configured connection:
// a new exclusive connection would not inherit its encryption and FK PRAGMAs.
const transactionTails = new WeakMap<SQLiteDatabase, Promise<void>>();

export async function runLocalTransaction(
  database: SQLiteDatabase,
  work: (transaction: SQLiteDatabase) => Promise<void>,
): Promise<void> {
  const previous = transactionTails.get(database) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  transactionTails.set(
    database,
    previous.then(() => turn),
  );
  await previous;
  try {
    if (typeof database.isInTransactionSync !== "function") {
      // Simple in-memory test doubles do not expose the native transaction state.
      await database.withTransactionAsync(() => work(database));
      return;
    }
    await database.execAsync("BEGIN IMMEDIATE");
    try {
      await work(database);
      await database.execAsync("COMMIT");
    } catch (error) {
      if (database.isInTransactionSync()) {
        await database.execAsync("ROLLBACK").catch(() => undefined);
      }
      // Never replace the useful failure with a secondary rollback error.
      throw error;
    }
  } finally {
    release();
  }
}
