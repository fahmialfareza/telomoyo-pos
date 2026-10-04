import { drizzle, type ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite";
import * as SQLite from "expo-sqlite";

import {
  INITIAL_TENANT_ID,
  type DataMode,
  type LocalScope,
  type Session,
  type DataScope,
} from "@/domain/types";
import { activeDataMode, activeTenantId } from "@/mode/mode-store";
import { getOrCreateDatabaseKey } from "@/security/secure-store";

import { runMigrations } from "./migrations";
import * as schema from "./schema";
import { runLocalTransaction } from "./transaction";

export interface DatabaseConnection {
  sqlite: SQLite.SQLiteDatabase;
  orm: ExpoSQLiteDatabase<typeof schema>;
}

export const databaseNames: Record<DataMode, string> = {
  production: "telomoyo-pos.db",
  sandbox: "telomoyo-pos-sandbox.db",
};

const connectionPromises: Record<
  string,
  Promise<DatabaseConnection> | undefined
> = {};

export function databaseScope(
  scope: LocalScope = activeDataMode(),
): DataScope & { tenantId: string } {
  if (
    typeof scope !== "string" &&
    "contextKind" in scope &&
    scope.contextKind !== undefined &&
    scope.contextKind !== "tenant"
  )
    throw new Error(
      "Pilih bisnis terlebih dahulu untuk membuka database operasional.",
    );
  if (
    typeof scope !== "string" &&
    "contextKind" in scope &&
    scope.contextKind === "tenant" &&
    !scope.tenantId
  )
    throw new Error("Identitas bisnis pada sesi tidak lengkap.");
  if (typeof scope !== "string" && !scope.tenantId)
    throw new Error(
      "Identitas bisnis wajib disertakan untuk membuka penyimpanan lokal.",
    );
  const value =
    typeof scope === "string"
      ? { dataMode: scope, tenantId: activeTenantId() }
      : { ...scope, tenantId: scope.tenantId! };
  if (!/^[a-f0-9-]{36}$/i.test(value.tenantId))
    throw new Error("Identitas bisnis tidak valid.");
  return value;
}

export function databaseName(scope: LocalScope): string {
  const value = databaseScope(scope);
  return value.tenantId === INITIAL_TENANT_ID
    ? databaseNames[value.dataMode]
    : `telomoyo-pos-${value.tenantId}-${value.dataMode}.db`;
}

export function getDatabase(
  scope: LocalScope = activeDataMode(),
): Promise<DatabaseConnection> {
  const value = databaseScope(scope);
  const key = `${value.tenantId}:${value.dataMode}`;
  const existing = connectionPromises[key];
  if (existing) return existing;

  let opening: Promise<DatabaseConnection>;
  opening = openDatabase(value).catch((error: unknown) => {
    if (connectionPromises[key] === opening) {
      delete connectionPromises[key];
    }
    throw error;
  });
  connectionPromises[key] = opening;
  return opening;
}

async function openDatabase(scope: DataScope): Promise<DatabaseConnection> {
  const key = await getOrCreateDatabaseKey(scope);
  const sqlite = await SQLite.openDatabaseAsync(databaseName(scope));
  try {
    // The generated key is hexadecimal only, so it cannot escape this pragma.
    await sqlite.execAsync(`
      PRAGMA key = "x'${key}'";
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
    `);
    await runMigrations(sqlite, {
      seedLegacyCatalog:
        scope.tenantId === INITIAL_TENANT_ID && scope.dataMode === "production",
    });

    return {
      sqlite,
      orm: drizzle(sqlite, { schema }),
    };
  } catch (error) {
    await sqlite.closeAsync().catch(() => undefined);
    throw error;
  }
}

export async function initializeDatabase(
  mode: LocalScope = activeDataMode(),
): Promise<void> {
  await getDatabase(mode);
}

export async function prepareDatabaseForSession(
  session: Pick<Session, "dataMode" | "sandboxGeneration"> &
    Partial<Pick<Session, "tenantId" | "contextKind" | "dataSpaceId">>,
): Promise<void> {
  if (session.contextKind && session.contextKind !== "tenant") return;
  if (session.dataMode === "production") {
    await initializeDatabase(session);
    return;
  }
  if (!session.sandboxGeneration) {
    throw new Error("Generasi Mode Uji pada sesi tidak valid.");
  }

  let connection = await getDatabase(session);
  const metadata = await connection.sqlite.getFirstAsync<{
    generation: number | null;
  }>("SELECT generation FROM sync_metadata WHERE singleton = 1");
  if (metadata?.generation === session.sandboxGeneration) return;

  await clearLocalDatabase(session);
  connection = await getDatabase(session);
  await runLocalTransaction(connection.sqlite, async (transaction) => {
    await transaction.execAsync(`
      DELETE FROM sync_conflicts;
      DELETE FROM print_attempts;
      DELETE FROM outbox_operations;
      DELETE FROM audit_events;
      DELETE FROM transaction_revisions;
      DELETE FROM transaction_items;
      DELETE FROM transactions;
      DELETE FROM synced_entities;
      DELETE FROM packages_local;
    `);
    await transaction.runAsync(
      `UPDATE sync_metadata
       SET generation = ?, cursor = NULL, status = 'idle',
           last_synced_at = NULL, last_error = NULL
       WHERE singleton = 1`,
      session.sandboxGeneration,
    );
  });
}

export async function clearLocalDatabase(scope: LocalScope): Promise<void> {
  const value = databaseScope(scope);
  const key = `${value.tenantId}:${value.dataMode}`;
  const existing = connectionPromises[key];
  delete connectionPromises[key];
  let failure: unknown;
  if (existing) {
    try {
      const connection = await existing;
      await connection.sqlite.closeAsync();
    } catch (error) {
      failure = error;
    }
  }
  try {
    await SQLite.deleteDatabaseAsync(databaseName(value));
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
}

export function resetDatabaseSingletonForTests(): void {
  for (const key of Object.keys(connectionPromises))
    delete connectionPromises[key];
}
