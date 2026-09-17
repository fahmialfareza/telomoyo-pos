import type { SQLiteDatabase } from "expo-sqlite";

import { applyRemoteChanges, listTransactions } from "@/db/repositories";
import { latestMigrationVersion, runMigrations } from "@/db/migrations";
import type { Transaction } from "@/domain/types";

const QRIS_PAYLOAD_HASH =
  "9185bbfe94bb008d611da515fc94c2f3ad5f0c3fbfe278d8bdb463f9ce1cf500";

const mockRunAsync = jest.fn<Promise<unknown>, unknown[]>();
const mockGetFirstAsync = jest.fn<Promise<unknown>, unknown[]>();
const mockGetAllAsync = jest.fn<Promise<unknown[]>, unknown[]>();
const mockWithTransactionAsync = jest.fn(
  async (callback: () => Promise<void>) => callback(),
);

jest.mock("@/db/client", () => ({
  getDatabase: async () => ({
    sqlite: {
      getFirstAsync: (...args: unknown[]) => mockGetFirstAsync(...args),
      getAllAsync: (...args: unknown[]) => mockGetAllAsync(...args),
      runAsync: (...args: unknown[]) => mockRunAsync(...args),
      withTransactionAsync: (callback: () => Promise<void>) =>
        mockWithTransactionAsync(callback),
    },
  }),
}));

const remoteTransaction: Transaction = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  revision: 1,
  occurredAt: "2026-07-28T00:00:00.000Z",
  subtotal: 70_000,
  total: 70_000,
  paymentAmount: 70_000,
  originActorId: "owner",
  originActorName: "Owner",
  updatedActorName: "Owner",
  terminalId: "terminal",
  syncState: "synced",
  printState: "pending",
  paymentMethod: "qris",
  paymentStatus: "pending",
  paymentConfirmedRevision: null,
  qrisPayloadHash: QRIS_PAYLOAD_HASH,
  deletedAt: null,
  items: [
    {
      id: "server-item-id",
      packageId: "00000000-0000-4000-8000-000000000001",
      packageRevision: 1,
      name: "Paket Standar",
      description: "Paket",
      accent: "standard",
      unitPrice: 70_000,
      quantity: 1,
      lineTotal: 70_000,
    },
  ],
};

describe("transaction item storage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunAsync.mockResolvedValue({});
    mockGetAllAsync.mockResolvedValue([]);
    mockGetFirstAsync.mockImplementation(async (sql) =>
      String(sql).includes("FROM sync_conflicts")
        ? null
        : { first_revision: null },
    );
  });

  it("searches TEST transaction display IDs using the raw stored ID", async () => {
    await listTransactions({ search: "TEST-TRX-01ARZ3N" });

    expect(mockGetAllAsync).toHaveBeenCalledWith(
      expect.stringContaining("id LIKE ?"),
      "%01ARZ3N%",
      "%01ARZ3N%",
      30,
      0,
    );
  });

  it("replaces the item set for a synced revision before inserting it", async () => {
    await applyRemoteChanges(
      [
        {
          cursor: "1",
          aggregate: "transaction",
          action: "upsert",
          aggregateId: remoteTransaction.id,
          payload: remoteTransaction,
          changedAt: "2026-07-28T00:00:01.000Z",
        },
      ],
      "1",
    );

    const calls = mockRunAsync.mock.calls;
    const deleteIndex = calls.findIndex(([sql]) =>
      String(sql).includes("DELETE FROM transaction_items"),
    );
    const insertIndex = calls.findIndex(([sql]) =>
      String(sql).includes("INSERT OR IGNORE INTO transaction_items"),
    );

    expect(deleteIndex).toBeGreaterThanOrEqual(0);
    expect(insertIndex).toBeGreaterThan(deleteIndex);
    expect(calls[deleteIndex]?.slice(1)).toEqual([
      remoteTransaction.id,
      remoteTransaction.revision,
    ]);
  });

  it("canonicalizes a pulled offset timestamp before SQLite persistence", async () => {
    await applyRemoteChanges(
      [
        {
          cursor: "offset-time",
          aggregate: "transaction",
          action: "upsert",
          aggregateId: remoteTransaction.id,
          payload: {
            ...remoteTransaction,
            occurredAt: "2026-07-29T18:00:00+07:00",
          },
          changedAt: "2026-07-29T11:00:01.000Z",
        },
      ],
      "offset-time",
    );

    const replaceCall = mockRunAsync.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO transactions"),
    );
    expect(replaceCall?.[3]).toBe("2026-07-29T11:00:00.000Z");
    expect(replaceCall?.[16]).toBe(QRIS_PAYLOAD_HASH);
  });

  it("removes rejected correction artifacts and preserves unresolved conflict state after a pull", async () => {
    mockGetFirstAsync.mockImplementation(async (sql) =>
      String(sql).includes("FROM sync_conflicts")
        ? null
        : { first_revision: 2 },
    );

    await applyRemoteChanges(
      [
        {
          cursor: "2",
          aggregate: "transaction",
          action: "upsert",
          aggregateId: remoteTransaction.id,
          payload: remoteTransaction,
          changedAt: "2026-07-28T00:00:02.000Z",
        },
      ],
      "2",
    );

    const calls = mockRunAsync.mock.calls;
    const artifactDeleteIndices = calls
      .map(([sql], index) =>
        String(sql).includes("revision >= ?") ? index : -1,
      )
      .filter((index) => index >= 0);
    const replaceIndex = calls.findIndex(([sql]) =>
      String(sql).includes("ON CONFLICT(id) DO UPDATE"),
    );
    expect(artifactDeleteIndices).toHaveLength(2);
    expect(artifactDeleteIndices.every((index) => index < replaceIndex)).toBe(
      true,
    );
    expect(
      artifactDeleteIndices.map((index) => calls[index]?.slice(1)),
    ).toEqual([
      [remoteTransaction.id, 2],
      [remoteTransaction.id, 2],
    ]);

    const resolutionIndex = calls.findIndex(([sql]) =>
      String(sql).includes("state IN ('rejected', 'discarded')"),
    );
    const recomputeIndex = calls.findIndex(([sql]) =>
      String(sql).includes("SET sync_state = CASE"),
    );
    expect(resolutionIndex).toBeGreaterThan(replaceIndex);
    expect(recomputeIndex).toBeGreaterThan(resolutionIndex);

    const recomputeSql = String(calls[recomputeIndex]?.[0]);
    const conflictBranch = recomputeSql.indexOf("state = 'conflict'");
    const rejectedBranch = recomputeSql.indexOf(
      "state IN ('rejected', 'discarded')",
    );
    const pendingBranch = recomputeSql.indexOf("state = 'pending'");
    expect(conflictBranch).toBeGreaterThanOrEqual(0);
    expect(conflictBranch).toBeLessThan(rejectedBranch);
    expect(rejectedBranch).toBeLessThan(pendingBranch);
    expect(calls[recomputeIndex]?.slice(1)).toEqual(
      Array(5).fill(remoteTransaction.id),
    );
    expect(String(calls[resolutionIndex]?.[0])).not.toContain(
      "state = 'conflict'",
    );
  });

  it("refreshes the conflict server snapshot before consuming a newer pull", async () => {
    const latest = {
      ...remoteTransaction,
      revision: 2,
      subtotal: 140_000,
      total: 140_000,
    };
    mockGetFirstAsync.mockImplementation(async (sql) =>
      String(sql).includes("FROM sync_conflicts")
        ? { server_json: JSON.stringify(remoteTransaction) }
        : { first_revision: null },
    );

    await applyRemoteChanges(
      [
        {
          cursor: "3",
          aggregate: "transaction",
          action: "upsert",
          aggregateId: latest.id,
          payload: latest,
          changedAt: "2026-07-28T00:00:03.000Z",
        },
      ],
      "3",
    );

    const refreshCall = mockRunAsync.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE sync_conflicts"),
    );
    expect(JSON.parse(String(refreshCall?.[1]))).toEqual({
      ...latest,
      syncState: "conflict",
    });
    expect(refreshCall?.[2]).toBe(latest.id);
  });

  it("records a pulled deletion in the unresolved server snapshot", async () => {
    const deletedAt = "2026-07-28T00:00:04.000Z";
    mockGetFirstAsync.mockImplementation(async (sql) =>
      String(sql).includes("FROM sync_conflicts")
        ? { server_json: JSON.stringify(remoteTransaction) }
        : { first_revision: null },
    );

    await applyRemoteChanges(
      [
        {
          cursor: "4",
          aggregate: "transaction",
          action: "delete",
          aggregateId: remoteTransaction.id,
          payload: null,
          changedAt: deletedAt,
        },
      ],
      "4",
    );

    const refreshCall = mockRunAsync.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE sync_conflicts"),
    );
    expect(JSON.parse(String(refreshCall?.[1]))).toEqual({
      ...remoteTransaction,
      syncState: "conflict",
      deletedAt,
    });
    const deletionCall = mockRunAsync.mock.calls.find(([sql]) =>
      String(sql).includes("SET deleted_at = COALESCE"),
    );
    expect(deletionCall?.slice(1)).toEqual([deletedAt, remoteTransaction.id]);
  });

  it("migrates legacy duplicates and installs a natural-key unique index", async () => {
    const execAsync = jest.fn<Promise<void>, [string]>().mockResolvedValue();
    const database = {
      getFirstAsync: jest.fn().mockResolvedValue({ user_version: 2 }),
      execAsync,
      withTransactionAsync: async (callback: () => Promise<void>) => callback(),
    } as unknown as SQLiteDatabase;

    await runMigrations(database);

    expect(latestMigrationVersion).toBe(11);
    const migrationSql = String(execAsync.mock.calls[0]?.[0]);
    expect(migrationSql).toContain("SELECT MAX(rowid)");
    expect(migrationSql).toContain(
      "transaction_items_package_revision_unique_idx",
    );
  });

  it("migrates legacy transactions to a printable legacy payment state", async () => {
    const execAsync = jest.fn<Promise<void>, [string]>().mockResolvedValue();
    const database = {
      getFirstAsync: jest.fn().mockResolvedValue({ user_version: 3 }),
      execAsync,
      withTransactionAsync: async (callback: () => Promise<void>) => callback(),
    } as unknown as SQLiteDatabase;

    await runMigrations(database);

    expect(latestMigrationVersion).toBe(11);
    const migrationSql = String(execAsync.mock.calls[0]?.[0]);
    expect(migrationSql).toContain("payment_method");
    expect(migrationSql).toContain("payment_status = 'success'");
    expect(migrationSql).toContain("payment_confirmed_revision = revision");
    expect(migrationSql).toContain("payment_method = 'legacy'");
  });

  it("preserves the printed revision and dependency order during sync", async () => {
    const execAsync = jest.fn<Promise<void>, [string]>().mockResolvedValue();
    const database = {
      getFirstAsync: jest.fn().mockResolvedValue({ user_version: 4 }),
      execAsync,
      withTransactionAsync: async (callback: () => Promise<void>) => callback(),
    } as unknown as SQLiteDatabase;

    await runMigrations(database);

    expect(latestMigrationVersion).toBe(11);
    const migrationSql = String(execAsync.mock.calls[0]?.[0]);
    expect(migrationSql).toContain("transaction_revision");
    expect(migrationSql).toContain("SET print_state = 'unknown'");
    expect(migrationSql).toContain("result = 'unknown'");
    expect(migrationSql).toContain("dependency_key");
    expect(migrationSql).toContain("$.payload.transactionId");
    expect(migrationSql).toContain("outbox_dependency_order_idx");
  });

  it("quarantines dependent operations behind terminal predecessors", async () => {
    const execAsync = jest.fn<Promise<void>, [string]>().mockResolvedValue();
    const database = {
      getFirstAsync: jest.fn().mockResolvedValue({ user_version: 5 }),
      execAsync,
      withTransactionAsync: async (callback: () => Promise<void>) => callback(),
    } as unknown as SQLiteDatabase;

    await runMigrations(database);

    expect(latestMigrationVersion).toBe(11);
    const migrationSql = String(execAsync.mock.calls[0]?.[0]);
    expect(migrationSql).toContain("Operasi dikarantina");
    expect(migrationSql).toContain(
      "predecessor.state IN ('conflict', 'rejected')",
    );
    expect(migrationSql).toContain("payment_status = 'pending'");
  });

  it("normalizes existing transaction timestamps to UTC", async () => {
    const execAsync = jest.fn<Promise<void>, [string]>().mockResolvedValue();
    const database = {
      getFirstAsync: jest.fn().mockResolvedValue({ user_version: 6 }),
      execAsync,
      withTransactionAsync: async (callback: () => Promise<void>) => callback(),
    } as unknown as SQLiteDatabase;

    await runMigrations(database);

    expect(latestMigrationVersion).toBe(11);
    const migrationSql = String(execAsync.mock.calls[0]?.[0]);
    expect(migrationSql).toContain("strftime(\n        '%Y-%m-%dT%H:%M:%fZ'");
    expect(migrationSql).toContain(
      "WHERE strftime('%s', occurred_at) IS NOT NULL",
    );
  });

  it("adds an immutable QRIS payload fingerprint to existing transactions", async () => {
    const execAsync = jest.fn<Promise<void>, [string]>().mockResolvedValue();
    const database = {
      getFirstAsync: jest.fn().mockResolvedValue({ user_version: 7 }),
      execAsync,
      withTransactionAsync: async (callback: () => Promise<void>) => callback(),
    } as unknown as SQLiteDatabase;

    await runMigrations(database);

    expect(latestMigrationVersion).toBe(11);
    const migrationSql = String(execAsync.mock.calls[0]?.[0]);
    expect(migrationSql).toContain("ADD COLUMN qris_payload_hash TEXT");
    expect(migrationSql).toContain("length(qris_payload_hash) = 64");
    expect(migrationSql).toContain("qris_payload_hash = lower");
  });
});
