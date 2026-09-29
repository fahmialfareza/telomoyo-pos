import type { SQLiteDatabase } from "expo-sqlite";

import { runMigrations } from "@/db/migrations";
import {
  applyRemoteChanges,
  beginPrintAttempt,
  correctTransaction,
  discardRejectedOutboxOperation,
  getOutboxOperations,
  getTransaction,
  listPackages,
  listTransactions,
  setPaymentStatus,
  upsertPackage,
} from "@/db/repositories";
import {
  INITIAL_TENANT_ID,
  PRODUCTION_DATA_SPACE_ID,
  type Session,
  type Transaction,
} from "@/domain/types";
import { setModeFromSession } from "@/mode/mode-store";
import { resetMutationBarrierForTests } from "@/mode/mutation-barrier";
import {
  quarantineScope,
  revalidateQuarantinedOperations,
} from "@/tenant/quarantine";
import {
  cacheTenantConfiguration,
  qrisPayloadForTransaction,
  receiptProfileForSession,
} from "@/tenant/configuration";

// Keep Node-only test bindings out of the React Native application's types.
interface TestSQLite {
  exec: (sql: string) => void;
  close: () => void;
  prepare: (sql: string) => {
    get: (
      ...params: (string | number | null)[]
    ) => Record<string, unknown> | undefined;
    all: (...params: (string | number | null)[]) => Record<string, unknown>[];
    run: (...params: (string | number | null)[]) => {
      changes: number | bigint;
      lastInsertRowid: number | bigint;
    };
  };
}
const { DatabaseSync } = jest.requireActual<{
  DatabaseSync: new (filename: string) => TestSQLite;
}>("node:sqlite");

const mockGetDatabase = jest.fn();
const mockApiRequest = jest.fn();
const mockSign = jest.fn(async () => "new-signature");
const mockWriteQrisConfig = jest.fn();
jest.mock("@/security/secure-store", () => ({
  writeQrisConfig: (...args: unknown[]) => mockWriteQrisConfig(...args),
  clearQrisConfig: jest.fn(),
}));
jest.mock("@/db/client", () => ({
  getDatabase: (...args: unknown[]) => mockGetDatabase(...args),
}));
jest.mock("@/api/client", () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}));
jest.mock("@/security/terminal-identity", () => ({
  getOrCreateTerminalIdentity: async () => ({ serverTerminalId: "terminal-a" }),
  signCanonicalPayload: () => mockSign(),
}));
jest.mock("expo-crypto", () => ({
  randomUUID: () => "11111111-1111-4111-8111-111111111111",
  getRandomBytes: (length: number) => new Uint8Array(length).fill(1),
}));

const session: Session = {
  token: "token-a",
  sessionId: "session-a",
  establishedAt: "2026-09-11T00:00:00Z",
  contextKind: "tenant",
  tenantId: INITIAL_TENANT_ID,
  dataMode: "production",
  dataSpaceId: PRODUCTION_DATA_SPACE_ID,
  sandboxGeneration: null,
  user: {
    id: "staff-a",
    username: "a",
    fullName: "Staff A",
    role: "superadmin",
    active: true,
    mustChangePassword: false,
  },
};
const otherTenant: Session = {
  ...session,
  tenantId: "00000000-0000-4000-8000-000000000201",
  dataSpaceId: "00000000-0000-4000-8000-000000000301",
  sessionId: "session-b",
  token: "token-b",
};
const transaction: Transaction = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  revision: 2,
  occurredAt: "2026-09-11T00:00:00.000Z",
  subtotal: 70000,
  total: 70000,
  paymentAmount: 70000,
  originActorId: "staff-a",
  originActorName: "Staff A",
  updatedActorName: "Staff A",
  terminalId: "terminal-a",
  syncState: "synced",
  printState: "pending",
  paymentMethod: "cash",
  paymentStatus: "success",
  paymentConfirmedRevision: 2,
  qrisPayloadHash: null,
  deletedAt: null,
  items: [
    {
      id: "item-a",
      packageId: "package-a",
      packageRevision: 1,
      name: "Paket A",
      description: "Paket",
      accent: "standard",
      unitPrice: 70000,
      quantity: 1,
      lineTotal: 70000,
    },
  ],
};

function connection() {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  const sqlite = {
    execAsync: async (sql: string) => raw.exec(sql),
    runAsync: async (sql: string, ...params: (string | number | null)[]) =>
      raw.prepare(sql).run(...params),
    getFirstAsync: async (sql: string, ...params: (string | number | null)[]) =>
      raw.prepare(sql).get(...params) ?? null,
    getAllAsync: async (sql: string, ...params: (string | number | null)[]) =>
      raw.prepare(sql).all(...params),
    withTransactionAsync: async (work: () => Promise<void>) => {
      raw.exec("BEGIN");
      try {
        await work();
        raw.exec("COMMIT");
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as SQLiteDatabase;
  return { raw, sqlite };
}

describe("tenant isolation with real SQLite", () => {
  let original: ReturnType<typeof connection>;
  let second: ReturnType<typeof connection>;
  beforeEach(async () => {
    jest.clearAllMocks();
    resetMutationBarrierForTests();
    setModeFromSession(session);
    mockSign.mockResolvedValue("new-signature");
    original = connection();
    second = connection();
    await runMigrations(original.sqlite);
    await runMigrations(second.sqlite, { seedLegacyCatalog: false });
    mockGetDatabase.mockImplementation(async (scope: Session) => {
      if (!scope?.tenantId) throw new Error("Explicit tenant scope required");
      return scope.tenantId === session.tenantId ? original : second;
    });
  });
  afterEach(() => {
    original.raw.close();
    second.raw.close();
    setModeFromSession(null);
    resetMutationBarrierForTests();
  });

  it("keeps legacy catalog only in Telomoyo and rejects delayed cross-tenant cache writes", async () => {
    const legacy = await listPackages(false, session);
    expect(legacy).toHaveLength(2);
    expect(await listPackages(false, otherTenant)).toEqual([]);
    setModeFromSession(otherTenant);
    await expect(upsertPackage(legacy[0]!, session)).rejects.toThrow(
      "ruang data yang sudah tidak aktif",
    );
    expect(await listPackages(false, otherTenant)).toEqual([]);
    expect(await listPackages(false, session)).toEqual(legacy);
  });

  it("hydrates current history items with real SQLite without crossing tenants or revisions", async () => {
    const older = {
      ...transaction,
      id: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
      revision: 1,
      paymentConfirmedRevision: 1,
      items: [{ ...transaction.items[0]!, id: "item-b", name: "Paket B" }],
    };
    await applyRemoteChanges(
      [
        {
          cursor: "1",
          aggregate: "transaction",
          action: "upsert",
          aggregateId: transaction.id,
          payload: transaction,
          changedAt: transaction.occurredAt,
        },
        {
          cursor: "2",
          aggregate: "transaction",
          action: "upsert",
          aggregateId: older.id,
          payload: older,
          changedAt: older.occurredAt,
        },
      ],
      "2",
      session,
    );
    const rows = await listTransactions({ limit: 3 }, session);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === transaction.id)?.items).toEqual(
      transaction.items,
    );
    expect(rows.find((row) => row.id === older.id)?.items).toEqual(older.items);
    expect(await listTransactions({ limit: 3 }, otherTenant)).toEqual([]);
  });

  it("isolates merchant profiles and exact historical QRIS bindings without falling back to another business", async () => {
    await expect(receiptProfileForSession(otherTenant)).rejects.toThrow(
      "Profil bisnis belum tersinkron",
    );
    await cacheTenantConfiguration(
      "profile",
      {
        businessName: "Bisnis B",
        address: "Jl. B",
        phone: "0812",
        revision: 2,
      },
      otherTenant,
    );
    expect((await receiptProfileForSession(otherTenant)).businessName).toBe(
      "Bisnis B",
    );
    expect((await receiptProfileForSession(session)).businessName).toBe(
      "Telomoyo",
    );
    await cacheTenantConfiguration(
      "qris",
      {
        revision: 2,
        activePayloadHash: "a-new",
        payloads: [
          { payloadHash: "a-old", staticPayload: "historical-a", revision: 1 },
          { payloadHash: "a-new", staticPayload: "active-a", revision: 2 },
        ],
      },
      session,
    );
    await cacheTenantConfiguration(
      "qris",
      {
        revision: 1,
        activePayloadHash: "b",
        payloads: [
          { payloadHash: "b", staticPayload: "active-b", revision: 1 },
        ],
      },
      otherTenant,
    );
    expect(await qrisPayloadForTransaction("a-old", session)).toBe(
      "historical-a",
    );
    expect(await qrisPayloadForTransaction("a-old", otherTenant)).toBeNull();
    expect(await qrisPayloadForTransaction("b", session)).toBeNull();
    expect(await qrisPayloadForTransaction("unknown", session)).toBeNull();
    expect(mockWriteQrisConfig).toHaveBeenCalledWith(
      { staticPayload: "active-a" },
      session.tenantId,
    );
    expect(mockWriteQrisConfig).toHaveBeenCalledWith(
      { staticPayload: "active-b" },
      otherTenant.tenantId,
    );
  });

  it("preserves quarantined bytes/revisions through another actor's pull and recovery, then re-fetches only after origin release", async () => {
    await applyRemoteChanges(
      [
        {
          cursor: "1",
          aggregate: "transaction",
          action: "upsert",
          aggregateId: transaction.id,
          payload: transaction,
          changedAt: transaction.occurredAt,
        },
      ],
      "1",
      session,
    );
    const proof = `{ "operationId": "op-a", "originActorId": "staff-a", "originSessionId": "old-a", "terminalId": "terminal-a", "payload": { "quantity": 2 } }`;
    original.raw
      .prepare(
        `INSERT INTO outbox_operations(operation_id, aggregate, aggregate_id, action, base_revision, operation_json, signature, state, last_error, occurred_at, dependency_key) VALUES ('op-a', 'transaction', ?, 'correct', 1, ?, 'original-signature', 'rejected', 'original-error', ?, ?)`,
      )
      .run(transaction.id, proof, transaction.occurredAt, transaction.id);
    original.raw
      .prepare(
        `INSERT INTO transaction_revisions(transaction_id, revision, after_json, origin_actor_id, submitting_actor_id, submitting_actor_name, terminal_id, client_occurred_at) VALUES (?, 2, ?, 'staff-a', 'staff-a', 'Staff A', 'terminal-a', ?)`,
      )
      .run(transaction.id, JSON.stringify(transaction), transaction.occurredAt);
    await quarantineScope(session, "MEMBERSHIP_INACTIVE");
    const snapshot = () =>
      JSON.stringify({
        queue: original.raw.prepare("SELECT * FROM outbox_operations").all(),
        transaction: original.raw.prepare("SELECT * FROM transactions").all(),
        items: original.raw.prepare("SELECT * FROM transaction_items").all(),
        revisions: original.raw
          .prepare("SELECT * FROM transaction_revisions")
          .all(),
      });
    const before = snapshot();
    const otherActor = {
      ...session,
      sessionId: "staff-b-session",
      user: { ...session.user, id: "staff-b" },
    };
    setModeFromSession(otherActor);
    await applyRemoteChanges(
      [
        {
          cursor: "2",
          aggregate: "transaction",
          action: "delete",
          aggregateId: transaction.id,
          payload: null,
          changedAt: transaction.occurredAt,
        },
        {
          cursor: "3",
          aggregate: "print_attempt",
          action: "upsert",
          aggregateId: "remote-print",
          payload: { transactionId: transaction.id, status: "failed" },
          changedAt: transaction.occurredAt,
        },
      ],
      "3",
      otherActor,
    );
    expect(await getOutboxOperations(25, otherActor)).toEqual([]);
    await discardRejectedOutboxOperation("op-a", otherActor);
    await expect(
      correctTransaction(
        transaction.id,
        { "package-a": 2 },
        "cash",
        null,
        "Test correction",
        otherActor,
      ),
    ).rejects.toThrow("dikarantina");
    await expect(
      setPaymentStatus(transaction.id, "failed", otherActor),
    ).rejects.toThrow("dikarantina");
    await expect(
      beginPrintAttempt({
        transactionId: transaction.id,
        transactionRevision: 2,
        session: otherActor,
        adapter: "simulator",
        isCopy: true,
      }),
    ).rejects.toThrow();
    expect(await revalidateQuarantinedOperations(otherActor)).toBe(0);
    expect(mockApiRequest).not.toHaveBeenCalled();
    expect(snapshot()).toBe(before);
    expect(await getTransaction(transaction.id, otherTenant)).toBeNull();

    mockApiRequest.mockResolvedValue({
      origins: [
        {
          originActorId: "staff-a",
          originSessionId: "old-a",
          terminalId: "terminal-a",
          allowed: true,
        },
      ],
    });
    setModeFromSession(session);
    expect(await revalidateQuarantinedOperations(session)).toBe(1);
    expect(
      original.raw.prepare("SELECT cursor FROM sync_metadata").get()?.cursor,
    ).toBeNull();
    expect(
      original.raw
        .prepare(
          "SELECT operation_json, signature, state FROM outbox_operations",
        )
        .get(),
    ).toEqual({
      operation_json: proof,
      signature: "original-signature",
      state: "rejected",
    });
    const server = { ...transaction, revision: 1, paymentConfirmedRevision: 1 };
    await applyRemoteChanges(
      [
        {
          cursor: "4",
          aggregate: "transaction",
          action: "upsert",
          aggregateId: server.id,
          payload: server,
          changedAt: server.occurredAt,
        },
      ],
      "4",
      session,
    );
    expect((await getTransaction(transaction.id, session))?.revision).toBe(1);
    expect(
      original.raw
        .prepare(
          "SELECT operation_json, signature, state FROM outbox_operations",
        )
        .get(),
    ).toEqual({
      operation_json: proof,
      signature: "original-signature",
      state: "resolved",
    });
  });

  it("quarantines an already-started local write if access is revoked while signing", async () => {
    await applyRemoteChanges(
      [
        {
          cursor: "1",
          aggregate: "transaction",
          action: "upsert",
          aggregateId: transaction.id,
          payload: {
            ...transaction,
            paymentStatus: "pending",
            paymentConfirmedRevision: null,
          },
          changedAt: transaction.occurredAt,
        },
      ],
      "1",
      session,
    );
    mockSign.mockImplementationOnce(async () => {
      await quarantineScope(session, "TENANT_SUSPENDED");
      return "original-in-flight-signature";
    });
    await setPaymentStatus(transaction.id, "success", session);
    expect(
      original.raw
        .prepare(
          "SELECT quarantine_reason, signature, state FROM outbox_operations",
        )
        .get(),
    ).toEqual({
      quarantine_reason: "TENANT_SUSPENDED",
      signature: "original-in-flight-signature",
      state: "pending",
    });
    expect(await getOutboxOperations(25, session)).toEqual([]);
  });

  it("does not alter existing signed operations when the tenant cache migration is applied again", async () => {
    const proof =
      '{ "originActorId": "legacy", "originSessionId": "original", "payload": { "exact": "bytes" } }';
    original.raw
      .prepare(
        "INSERT INTO outbox_operations(operation_id, aggregate, aggregate_id, action, operation_json, signature, occurred_at) VALUES ('legacy', 'transaction', 'legacy-tx', 'create', ?, 'legacy-signature', '2026-09-11')",
      )
      .run(proof);
    // Simulate an existing v9 device receiving the additive tenant migration.
    original.raw.exec(
      "DROP TABLE tenant_configuration; DROP TABLE scope_access; ALTER TABLE outbox_operations DROP COLUMN quarantine_reason; ALTER TABLE transactions DROP COLUMN receipt_identity_json; PRAGMA user_version = 9",
    );
    const before = original.raw
      .prepare("SELECT * FROM outbox_operations")
      .get();
    await runMigrations(original.sqlite);
    expect(
      original.raw.prepare("SELECT * FROM outbox_operations").get(),
    ).toEqual({ ...before, quarantine_reason: null });
  });
});
