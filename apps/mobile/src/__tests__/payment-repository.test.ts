import type { Session, Transaction } from "@/domain/types";
import {
  applyRemoteChanges,
  beginPrintAttempt,
  completePrintAttempt,
  correctTransaction,
  createTransaction,
  discardRejectedOutboxOperation,
  getDashboardStats,
  getOutboxOperations,
  markOutboxResult,
  resolveConflict,
  setPaymentStatus,
} from "@/db/repositories";
import { setModeFromSession } from "@/mode/mode-store";
import {
  beginModeTransition,
  MODE_TRANSITION_BUSY_MESSAGE,
  resetMutationBarrierForTests,
} from "@/mode/mutation-barrier";

const QRIS_PAYLOAD_HASH =
  "9185bbfe94bb008d611da515fc94c2f3ad5f0c3fbfe278d8bdb463f9ce1cf500";

jest.mock("@/tenant/configuration", () => ({
  receiptProfileForSession: async () => ({
    businessName: "Telomoyo",
    address: "",
    phone: "",
    revision: 1,
  }),
}));

const mockGetFirstAsync = jest.fn<Promise<unknown>, unknown[]>();
const mockHasQuarantine = jest.fn(async () => ({ blocked: 0 }));
const mockGetAllAsync = jest.fn<Promise<unknown[]>, unknown[]>();
const mockRunAsync = jest.fn<Promise<unknown>, unknown[]>();
const mockWithTransactionAsync = jest.fn(
  async (callback: () => Promise<void>) => callback(),
);

jest.mock("@/db/client", () => ({
  getDatabase: async () => ({
    sqlite: {
      getFirstAsync: (...args: unknown[]) =>
        String(args[0]).startsWith(
          "SELECT EXISTS(SELECT 1 FROM outbox_operations WHERE dependency_key = ? AND quarantine_reason",
        )
          ? mockHasQuarantine()
          : mockGetFirstAsync(...args),
      getAllAsync: (...args: unknown[]) => mockGetAllAsync(...args),
      runAsync: (...args: unknown[]) => mockRunAsync(...args),
      withTransactionAsync: (callback: () => Promise<void>) =>
        mockWithTransactionAsync(callback),
    },
  }),
}));

jest.mock("@/security/terminal-identity", () => ({
  getOrCreateTerminalIdentity: async () => ({
    serverTerminalId: "terminal-1",
  }),
  signCanonicalPayload: async () => "signature",
}));

jest.mock("expo-crypto", () => ({
  randomUUID: () => "11111111-1111-4111-8111-111111111111",
  getRandomBytes: (length: number) => new Uint8Array(length).fill(1),
}));

const session: Session = {
  token: "token",
  sessionId: "session-1",
  establishedAt: "2026-07-29T00:00:00.000Z",
  dataMode: "production",
  dataSpaceId: "00000000-0000-4000-8000-000000000100",
  sandboxGeneration: null,
  user: {
    id: "actor-1",
    fullName: "Andi",
    username: "andi",
    role: "admin",
    active: true,
    mustChangePassword: false,
  },
};

const row = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  revision: 2,
  occurred_at: "2026-07-29T00:00:00.000Z",
  subtotal: 70_000,
  total: 70_000,
  payment_amount: 70_000,
  origin_actor_id: "actor-1",
  origin_actor_name: "Andi",
  updated_actor_name: "Andi",
  terminal_id: "terminal-1",
  sync_state: "synced",
  print_state: "pending",
  payment_method: "cash",
  payment_status: "pending",
  payment_confirmed_revision: null,
  qris_payload_hash: null,
  deleted_at: null,
};

const item = {
  id: "item-1",
  package_id: "package-1",
  package_revision: 1,
  name: "Paket Standar",
  description: "Paket",
  accent: "standard",
  unit_price: 70_000,
  quantity: 1,
  line_total: 70_000,
};

const transaction: Transaction = {
  id: row.id,
  revision: row.revision,
  occurredAt: row.occurred_at,
  subtotal: row.subtotal,
  total: row.total,
  paymentAmount: row.total,
  originActorId: row.origin_actor_id,
  originActorName: row.origin_actor_name,
  updatedActorName: row.updated_actor_name,
  terminalId: row.terminal_id,
  syncState: "synced",
  printState: "pending",
  paymentMethod: "cash",
  paymentStatus: "pending",
  paymentConfirmedRevision: row.payment_confirmed_revision,
  qrisPayloadHash: null,
  deletedAt: row.deleted_at,
  items: [
    {
      id: item.id,
      packageId: item.package_id,
      packageRevision: item.package_revision,
      name: item.name,
      description: item.description,
      accent: "standard",
      unitPrice: item.unit_price,
      quantity: item.quantity,
      lineTotal: item.line_total,
    },
  ],
};

const correctionOperation = {
  operationId: "old-operation",
  aggregate: "transaction",
  aggregateId: row.id,
  action: "correct",
  baseRevision: 1,
  originSessionId: session.sessionId,
  originActorId: session.user.id,
  terminalId: row.terminal_id,
  occurredAt: row.occurred_at,
  payload: {
    id: row.id,
    reason: "Koreksi jumlah paket",
    paymentMethod: "cash",
    qrisPayloadHash: null,
    items: [
      {
        packageId: item.package_id,
        packageRevision: item.package_revision,
        quantity: item.quantity,
      },
    ],
  },
};
const correctionOperationJson = JSON.stringify(correctionOperation);
const conflict = {
  id: "conflict-1",
  transactionId: row.id,
  localSnapshot: transaction,
  serverSnapshot: {
    ...transaction,
    revision: transaction.revision + 1,
    subtotal: 140_000,
    total: 140_000,
    paymentMethod: "qris" as const,
    items: [
      {
        ...transaction.items[0]!,
        id: "server-item-1",
        quantity: 2,
        lineTotal: 140_000,
      },
    ],
  },
  createdAt: row.occurred_at,
};

function arrangeConflictResolution(): void {
  mockGetFirstAsync
    .mockResolvedValueOnce({
      operation_id: correctionOperation.operationId,
      operation_json: correctionOperationJson,
    })
    .mockResolvedValueOnce({ operation_json: correctionOperationJson })
    .mockResolvedValueOnce({
      id: conflict.id,
      local_json: JSON.stringify(conflict.localSnapshot),
      server_json: JSON.stringify(conflict.serverSnapshot),
    });
}

describe("payment-aware transaction repository", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetMutationBarrierForTests();
    setModeFromSession(session);
    mockGetFirstAsync.mockReset();
    mockHasQuarantine.mockResolvedValue({ blocked: 0 });
    mockGetAllAsync.mockReset();
    mockRunAsync.mockReset();
    mockGetFirstAsync.mockResolvedValue(row);
    mockGetAllAsync.mockResolvedValue([item]);
    mockRunAsync.mockResolvedValue({});
  });

  afterEach(() => {
    resetMutationBarrierForTests();
  });

  it("blocks a user mutation while a mode handoff owns the barrier", async () => {
    const transitionLease = await beginModeTransition();
    try {
      await expect(
        createTransaction(
          [
            {
              package: {
                id: "package-1",
                revision: 1,
                name: "Paket Standar",
                description: "Paket",
                accent: "standard",
                unitPrice: 70_000,
                active: true,
                deletedAt: null,
              },
              quantity: 1,
            },
          ],
          "cash",
          null,
          session,
        ),
      ).rejects.toThrow(MODE_TRANSITION_BUSY_MESSAGE);

      expect(mockRunAsync).not.toHaveBeenCalled();
    } finally {
      transitionLease.release();
    }
  });

  it("still admits sync-owned remote package writes during the drain", async () => {
    const transitionLease = await beginModeTransition();
    try {
      await expect(
        applyRemoteChanges(
          [
            {
              cursor: "CURSOR-2",
              aggregate: "package",
              aggregateId: "package-2",
              action: "upsert",
              payload: {
                id: "package-2",
                revision: 2,
                name: "Paket Sinkron",
                description: "Dari server",
                unitPrice: 80_000,
                accent: "sunrise",
                active: true,
                deletedAt: null,
              },
              changedAt: "2026-09-08T00:00:00.000Z",
            },
          ],
          "CURSOR-2",
          "production",
        ),
      ).resolves.toBeUndefined();

      expect(mockRunAsync).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO packages_local"),
        "package-2",
        2,
        "Paket Sinkron",
        "Dari server",
        80_000,
        "sunrise",
        1,
        null,
        expect.any(String),
      );
    } finally {
      transitionLease.release();
    }
  });

  it("creates a payment-confirmed transaction with an explicit signed payment method", async () => {
    const created = await createTransaction(
      [
        {
          package: {
            id: "package-1",
            revision: 1,
            name: "Paket Standar",
            description: "Paket",
            accent: "standard",
            unitPrice: 70_000,
            active: true,
            deletedAt: null,
          },
          quantity: 1,
        },
      ],
      "qris",
      QRIS_PAYLOAD_HASH,
      session,
    );

    expect(created).toMatchObject({
      paymentMethod: "qris",
      paymentStatus: "success",
      paymentConfirmedRevision: 1,
      qrisPayloadHash: QRIS_PAYLOAD_HASH,
    });
    const outboxCall = mockRunAsync.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO outbox_operations"),
    );
    const operation = JSON.parse(String(outboxCall?.[6])) as {
      payload: unknown;
    };
    expect(operation.payload).toMatchObject({
      paymentMethod: "qris",
      qrisPayloadHash: QRIS_PAYLOAD_HASH,
    });
    const transactionInsert = mockRunAsync.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO transactions"),
    );
    expect(transactionInsert?.[16]).toBe(QRIS_PAYLOAD_HASH);
  });

  it("stores the full Sandbox package total for a compatible QRIS transaction", async () => {
    const sandboxSession: Session = {
      ...session,
      dataMode: "sandbox",
      dataSpaceId: "00000000-0000-4000-8000-000000000200",
      sandboxGeneration: 1,
      protocolVersion: 3,
      sandboxQrisPolicy: "transaction_total",
    };
    setModeFromSession(sandboxSession);
    const created = await createTransaction(
      [
        {
          package: {
            id: "package-1",
            revision: 1,
            name: "Paket Standar",
            description: "Paket",
            accent: "standard",
            unitPrice: 70_000,
            active: true,
            deletedAt: null,
          },
          quantity: 2,
        },
      ],
      "qris",
      QRIS_PAYLOAD_HASH,
      sandboxSession,
    );

    expect(created.total).toBe(140_000);
    expect(created.paymentAmount).toBe(140_000);
    const transactionInsert = mockRunAsync.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO transactions"),
    );
    expect(transactionInsert?.[6]).toBe(140_000);
  });

  it("does not create or sign new Sandbox entries from a legacy session", async () => {
    const legacy: Session = {
      ...session,
      dataMode: "sandbox",
      sandboxGeneration: 1,
    };
    setModeFromSession(legacy);
    await expect(
      createTransaction([], "qris", QRIS_PAYLOAD_HASH, legacy),
    ).rejects.toThrow("Sesi Mode Uji perlu diperbarui");
    expect(mockRunAsync).not.toHaveBeenCalled();
  });

  it("blocks printing until payment succeeds for the current revision", async () => {
    await expect(
      beginPrintAttempt({
        transactionId: row.id,
        transactionRevision: row.revision,
        adapter: "simulator",
        isCopy: false,
        session,
      }),
    ).rejects.toThrow("Pembayaran harus berhasil");
    expect(mockRunAsync).not.toHaveBeenCalled();

    mockGetFirstAsync.mockResolvedValueOnce({
      ...row,
      payment_status: "success",
      payment_confirmed_revision: 1,
    });
    await expect(
      beginPrintAttempt({
        transactionId: row.id,
        transactionRevision: row.revision,
        adapter: "simulator",
        isCopy: false,
        session,
      }),
    ).rejects.toThrow("revisi transaksi saat ini");
    expect(mockRunAsync).not.toHaveBeenCalled();
  });

  it("records a signed status mutation and confirms the current revision", async () => {
    const updated = await setPaymentStatus(row.id, "success", session);

    expect(updated.paymentStatus).toBe("success");
    expect(updated.paymentConfirmedRevision).toBe(row.revision);
    const outboxCall = mockRunAsync.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO outbox_operations"),
    );
    const operation = JSON.parse(String(outboxCall?.[6])) as {
      action: string;
      baseRevision: number;
      payload: unknown;
    };
    expect(operation).toMatchObject({
      action: "set_payment_status",
      baseRevision: row.revision,
      payload: { id: row.id, status: "success" },
    });

    const auditCall = mockRunAsync.mock.calls.find(([sql]) =>
      String(sql).includes("'payment.status_changed'"),
    );
    const auditPayload = JSON.parse(String(auditCall?.[6])) as {
      before: Transaction;
      after: Transaction;
    };
    expect(auditPayload.before).toEqual(transaction);
    expect(auditPayload.after).toEqual({
      ...transaction,
      syncState: "pending",
      paymentStatus: "success",
      paymentConfirmedRevision: row.revision,
    });
  });

  it("reconfirms payment automatically when a paid transaction is corrected", async () => {
    mockGetFirstAsync.mockResolvedValueOnce({
      ...row,
      print_state: "success",
      payment_status: "success",
      payment_confirmed_revision: row.revision,
    });

    const corrected = await correctTransaction(
      row.id,
      { "package-1": 2 },
      "qris",
      QRIS_PAYLOAD_HASH,
      "Jumlah paket diperbaiki",
      session,
    );

    expect(corrected).toMatchObject({
      revision: 3,
      paymentMethod: "qris",
      paymentStatus: "success",
      paymentConfirmedRevision: 3,
      qrisPayloadHash: QRIS_PAYLOAD_HASH,
      printState: "needs-reprint",
    });
    const transactionUpdate = mockRunAsync.mock.calls.find(([sql]) =>
      String(sql).includes("qris_payload_hash = ?"),
    );
    expect(transactionUpdate?.[10]).toBe(QRIS_PAYLOAD_HASH);
    const revisionInsert = mockRunAsync.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO transaction_revisions"),
    );
    expect(JSON.parse(String(revisionInsert?.[5]))).toMatchObject({
      revision: 3,
      qrisPayloadHash: QRIS_PAYLOAD_HASH,
    });
    const outboxInsert = mockRunAsync.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO outbox_operations"),
    );
    expect(JSON.parse(String(outboxInsert?.[6])).payload).toMatchObject({
      paymentMethod: "qris",
      qrisPayloadHash: QRIS_PAYLOAD_HASH,
    });
  });

  it("allows a print attempt after exact-revision confirmation", async () => {
    mockGetFirstAsync.mockResolvedValueOnce({
      ...row,
      payment_status: "success",
      payment_confirmed_revision: row.revision,
    });

    await expect(
      beginPrintAttempt({
        transactionId: row.id,
        transactionRevision: row.revision,
        adapter: "simulator",
        isCopy: false,
        session,
      }),
    ).resolves.toBe("11111111-1111-4111-8111-111111111111");
    expect(
      mockRunAsync.mock.calls.some(([sql]) =>
        String(sql).includes("INSERT INTO print_attempts"),
      ),
    ).toBe(true);
  });

  it("refuses to start printing a stale transaction revision", async () => {
    mockGetFirstAsync.mockResolvedValueOnce({
      ...row,
      revision: row.revision + 1,
      payment_status: "success",
      payment_confirmed_revision: row.revision + 1,
    });

    await expect(
      beginPrintAttempt({
        transactionId: row.id,
        transactionRevision: row.revision,
        adapter: "simulator",
        isCopy: false,
        session,
      }),
    ).rejects.toThrow("Transaksi berubah sebelum pencetakan");
    expect(mockRunAsync).not.toHaveBeenCalled();
  });

  it("keeps printing locked while a revision conflict is unresolved", async () => {
    mockGetFirstAsync.mockResolvedValueOnce({
      ...row,
      sync_state: "conflict",
      payment_status: "success",
      payment_confirmed_revision: row.revision,
    });

    await expect(
      beginPrintAttempt({
        transactionId: row.id,
        transactionRevision: row.revision,
        adapter: "simulator",
        isCopy: false,
        session,
      }),
    ).rejects.toThrow("Selesaikan konflik revisi");
    expect(mockGetFirstAsync).toHaveBeenCalledTimes(1);
    expect(mockRunAsync).not.toHaveBeenCalled();
  });

  it("keeps server-rejected transactions locked after acknowledgement", async () => {
    mockGetFirstAsync
      .mockResolvedValueOnce({
        ...row,
        payment_status: "success",
        payment_confirmed_revision: row.revision,
      })
      .mockResolvedValueOnce({ blocked: 1 });

    await expect(
      beginPrintAttempt({
        transactionId: row.id,
        transactionRevision: row.revision,
        adapter: "simulator",
        isCopy: false,
        session,
      }),
    ).rejects.toThrow("ditolak server");
    expect(mockRunAsync).not.toHaveBeenCalled();
  });

  it("reports the revision captured when the print attempt began", async () => {
    mockGetFirstAsync.mockResolvedValueOnce({
      transaction_id: row.id,
      adapter: "simulator",
      is_copy: 0,
      transaction_revision: row.revision,
    });

    await completePrintAttempt({
      attemptId: "print-attempt-1",
      transactionId: row.id,
      result: "success",
      session,
    });

    const outboxCall = mockRunAsync.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO outbox_operations"),
    );
    const operation = JSON.parse(String(outboxCall?.[6])) as {
      payload: { transactionRevision: number };
    };
    expect(operation.payload.transactionRevision).toBe(row.revision);

    const printStateCall = mockRunAsync.mock.calls.find(([sql]) =>
      String(sql).includes("SET print_state = ?"),
    );
    expect(String(printStateCall?.[0])).toContain("AND revision = ?");
    expect(printStateCall?.slice(1)).toEqual(["success", row.id, row.revision]);
  });

  it("refuses to complete a print attempt for another transaction", async () => {
    mockGetFirstAsync.mockResolvedValueOnce({
      transaction_id: "another-transaction",
      adapter: "simulator",
      is_copy: 0,
      transaction_revision: row.revision,
    });

    await expect(
      completePrintAttempt({
        attemptId: "print-attempt-1",
        transactionId: row.id,
        result: "success",
        session,
      }),
    ).rejects.toThrow("tidak sesuai dengan transaksi");
    expect(mockRunAsync).not.toHaveBeenCalled();
  });

  it("treats repeated success confirmation as a harmless no-op", async () => {
    mockGetFirstAsync.mockResolvedValueOnce({
      ...row,
      payment_status: "success",
      payment_confirmed_revision: row.revision,
    });

    await expect(
      setPaymentStatus(row.id, "success", session),
    ).resolves.toMatchObject({
      paymentStatus: "success",
      paymentConfirmedRevision: row.revision,
    });
    expect(mockRunAsync).not.toHaveBeenCalled();
  });

  it("does not re-confirm payment while a terminal rejection is unresolved", async () => {
    mockGetFirstAsync
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce({ blocked: 1 });

    await expect(setPaymentStatus(row.id, "success", session)).rejects.toThrow(
      "ditolak server",
    );
    expect(mockRunAsync).not.toHaveBeenCalled();
  });

  it("does not re-confirm payment while a revision conflict is unresolved", async () => {
    mockGetFirstAsync.mockResolvedValueOnce({
      ...row,
      sync_state: "conflict",
    });

    await expect(setPaymentStatus(row.id, "success", session)).rejects.toThrow(
      "Selesaikan konflik revisi",
    );
    expect(mockGetFirstAsync).toHaveBeenCalledTimes(1);
    expect(mockRunAsync).not.toHaveBeenCalled();
  });

  it("orders dependent offline operations deterministically", async () => {
    mockGetAllAsync.mockResolvedValueOnce([]);

    await getOutboxOperations();

    expect(String(mockGetAllAsync.mock.calls[0]?.[0])).toContain(
      "ORDER BY candidate.rowid ASC",
    );
    expect(String(mockGetAllAsync.mock.calls[0]?.[0])).toContain(
      "predecessor.dependency_key = candidate.dependency_key",
    );
    expect(String(mockGetAllAsync.mock.calls[0]?.[0])).toContain(
      "predecessor.rowid < candidate.rowid",
    );
  });

  it("treats payment conflicts as terminal and rejects later dependent operations", async () => {
    const authoritative: Transaction = {
      ...transaction,
      revision: transaction.revision + 1,
      occurredAt: "2026-07-29T00:02:00.000Z",
      subtotal: 140_000,
      total: 140_000,
      syncState: "synced",
      paymentMethod: "qris",
      paymentStatus: "success",
      paymentConfirmedRevision: transaction.revision + 1,
      qrisPayloadHash: QRIS_PAYLOAD_HASH,
      items: [
        {
          ...transaction.items[0]!,
          id: "server-item-1",
          quantity: 2,
          lineTotal: 140_000,
        },
      ],
    };
    mockGetFirstAsync.mockResolvedValueOnce({
      dependency_key: row.id,
      aggregate: "transaction",
      action: "set_payment_status",
      operation_json: JSON.stringify({
        operationId: "operation-1",
        aggregate: "transaction",
        aggregateId: row.id,
        action: "set_payment_status",
        baseRevision: row.revision,
        originSessionId: session.sessionId,
        originActorId: session.user.id,
        terminalId: row.terminal_id,
        occurredAt: row.occurred_at,
        payload: { id: row.id, status: "success" },
      }),
    });

    await markOutboxResult("operation-1", row.id, {
      kind: "payment-conflict",
      message: "Status pembayaran sudah berubah.",
      paymentStatus: "success",
      paymentConfirmedRevision: authoritative.revision,
      authoritative,
    });

    const transactionCall = mockRunAsync.mock.calls.find(([sql]) =>
      String(sql).includes("ON CONFLICT(id) DO UPDATE"),
    );
    expect(transactionCall?.[1]).toBe(authoritative.id);
    expect(transactionCall?.[2]).toBe(authoritative.revision);
    expect(transactionCall?.[11]).toBe("error");
    expect(transactionCall?.[13]).toBe(authoritative.paymentMethod);
    expect(transactionCall?.[14]).toBe(authoritative.paymentStatus);
    expect(transactionCall?.[15]).toBe(authoritative.paymentConfirmedRevision);

    const auditCall = mockRunAsync.mock.calls.find(([sql]) =>
      String(sql).includes("'sync.payment_conflict_authoritative'"),
    );
    expect(auditCall?.slice(2, 6)).toEqual([
      row.id,
      session.user.id,
      session.sessionId,
      row.terminal_id,
    ]);
    expect(JSON.parse(String(auditCall?.[6]))).toEqual({
      operationId: "operation-1",
      authoritative: { ...authoritative, syncState: "error" },
    });

    const cascadeCall = mockRunAsync.mock.calls.find(([sql]) =>
      String(sql).includes("rowid >"),
    );
    expect(String(cascadeCall?.[0])).toContain("state IN ('pending', 'error')");
    expect(cascadeCall?.slice(2)).toEqual([row.id, "operation-1"]);
  });

  it("clears optimistic payment confirmation when a transaction mutation is rejected", async () => {
    mockGetFirstAsync.mockResolvedValueOnce({
      dependency_key: row.id,
      aggregate: "transaction",
      action: "correct",
    });

    await markOutboxResult("operation-1", row.id, {
      kind: "rejected",
      message: "Koreksi ditolak.",
    });

    const resetCall = mockRunAsync.mock.calls.find(([sql]) =>
      String(sql).includes("payment_status = 'pending'"),
    );
    expect(String(resetCall?.[0])).toContain(
      "payment_confirmed_revision = NULL",
    );
    expect(resetCall?.[1]).toBe(row.id);
  });

  it("preserves paid evidence when the server rejects a local create", async () => {
    mockGetFirstAsync
      .mockResolvedValueOnce({
        dependency_key: row.id,
        aggregate: "transaction",
        action: "create",
      })
      .mockResolvedValueOnce({
        payment_status: "success",
        has_print_attempt: 0,
      });

    await markOutboxResult("operation-1", row.id, {
      kind: "rejected",
      message: "Transaksi ditolak.",
    });

    const evidenceQuery = String(mockGetFirstAsync.mock.calls[1]?.[0]);
    expect(evidenceQuery).toContain("payment_status");
    expect(evidenceQuery).toContain("FROM print_attempts");
    expect(
      mockRunAsync.mock.calls.some(([sql]) =>
        String(sql).includes("payment_confirmed_revision = NULL"),
      ),
    ).toBe(false);
    expect(
      mockRunAsync.mock.calls.some(
        ([sql, transactionId]) =>
          String(sql).includes("SET sync_state = 'error'") &&
          transactionId === row.id,
      ),
    ).toBe(true);
  });

  it("preserves paid evidence when a rejected create also rejects its queued payment", async () => {
    mockGetFirstAsync
      .mockResolvedValueOnce({
        dependency_key: row.id,
        aggregate: "transaction",
        action: "set_payment_status",
      })
      .mockResolvedValueOnce({ has_rejected_create: 1 })
      .mockResolvedValueOnce({
        payment_status: "success",
        has_print_attempt: 0,
      });

    await markOutboxResult("payment-operation", row.id, {
      kind: "rejected",
      message: "Operasi pembayaran ikut ditolak.",
    });

    expect(
      mockRunAsync.mock.calls.some(([sql]) =>
        String(sql).includes("payment_confirmed_revision = NULL"),
      ),
    ).toBe(false);
  });

  it("clears optimistic payment confirmation on a revision conflict", async () => {
    mockGetFirstAsync.mockResolvedValueOnce({
      dependency_key: row.id,
      aggregate: "transaction",
      action: "correct",
    });

    await markOutboxResult("operation-1", row.id, {
      kind: "conflict",
      local: transaction,
      server: { ...transaction, revision: transaction.revision + 1 },
    });

    const conflictCall = mockRunAsync.mock.calls.find(([sql]) =>
      String(sql).includes("sync_state = 'conflict'"),
    );
    expect(String(conflictCall?.[0])).toContain("payment_status = 'pending'");
    expect(String(conflictCall?.[0])).toContain(
      "payment_confirmed_revision = NULL",
    );
    expect(conflictCall?.[1]).toBe(row.id);
  });

  it("does not recover a rejected descendant while its revision conflict is unresolved", async () => {
    mockGetFirstAsync.mockResolvedValueOnce({
      operation_id: "operation-2",
      aggregate: "transaction",
      action: "set_payment_status",
      dependency_key: row.id,
      base_revision: row.revision,
      occurred_at: row.occurred_at,
      last_error: "Operasi lanjutan dibatalkan.",
      queue_order: 2,
      has_conflict: 1,
    });

    await expect(
      discardRejectedOutboxOperation("operation-2", session),
    ).rejects.toThrow("Selesaikan konflik revisi");
    expect(mockGetAllAsync).not.toHaveBeenCalled();
    expect(mockRunAsync).not.toHaveBeenCalled();
  });

  it("clears the terminal block after accepting the server conflict snapshot", async () => {
    arrangeConflictResolution();

    await resolveConflict(conflict, "server", session);

    const resolutionCall = mockRunAsync.mock.calls.find(([sql]) => {
      const statement = String(sql);
      return (
        statement.includes("state = 'resolved'") &&
        statement.includes("state = 'conflict'")
      );
    });
    expect(String(resolutionCall?.[0])).toContain("last_error = NULL");

    const artifactDeletes = mockRunAsync.mock.calls.filter(([sql]) =>
      String(sql).includes("revision >= ?"),
    );
    expect(artifactDeletes.map((call) => call.slice(1))).toEqual([
      [row.id, transaction.revision],
      [row.id, transaction.revision],
    ]);
  });

  it("rebases a retried correction exactly and cleans discarded optimistic artifacts", async () => {
    arrangeConflictResolution();

    await resolveConflict(conflict, "retry-local", session);

    const rebasedRevision = conflict.serverSnapshot.revision + 1;
    const artifactDeletes = mockRunAsync.mock.calls.filter(([sql]) =>
      String(sql).includes("revision >= ?"),
    );
    expect(artifactDeletes.map((call) => call.slice(1))).toEqual([
      [row.id, conflict.localSnapshot.revision],
      [row.id, conflict.localSnapshot.revision],
    ]);

    const replaceCall = mockRunAsync.mock.calls.find(([sql]) =>
      String(sql).includes("ON CONFLICT(id) DO UPDATE"),
    );
    expect(replaceCall?.[1]).toBe(row.id);
    expect(replaceCall?.[2]).toBe(rebasedRevision);
    expect(replaceCall?.[11]).toBe("pending");
    expect(replaceCall?.[14]).toBe("pending");
    expect(replaceCall?.[15]).toBeNull();

    const revisionCall = mockRunAsync.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO transaction_revisions"),
    );
    expect(revisionCall?.slice(1, 4)).toEqual([
      row.id,
      rebasedRevision,
      correctionOperation.payload.reason,
    ]);
    expect(JSON.parse(String(revisionCall?.[4]))).toEqual({
      ...conflict.serverSnapshot,
      syncState: "synced",
    });
    expect(JSON.parse(String(revisionCall?.[5]))).toEqual({
      ...conflict.localSnapshot,
      revision: rebasedRevision,
      syncState: "pending",
      paymentStatus: "pending",
      paymentConfirmedRevision: null,
    });

    const outboxCall = mockRunAsync.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO outbox_operations"),
    );
    expect(JSON.parse(String(outboxCall?.[6]))).toMatchObject({
      operationId: "11111111-1111-4111-8111-111111111111",
      action: "correct",
      baseRevision: conflict.serverSnapshot.revision,
      payload: correctionOperation.payload,
    });
    expect(outboxCall?.[8]).toBe(row.id);

    const descendantCleanup = mockRunAsync.mock.calls.find(([sql]) =>
      String(sql).includes("state = 'rejected'"),
    );
    expect(String(descendantCleanup?.[0])).toContain("state = 'resolved'");
    expect(descendantCleanup?.[1]).toBe(row.id);
  });

  it("aborts conflict resolution when a newer server snapshot was pulled", async () => {
    mockGetFirstAsync
      .mockResolvedValueOnce({
        operation_id: correctionOperation.operationId,
        operation_json: correctionOperationJson,
      })
      .mockResolvedValueOnce({ operation_json: correctionOperationJson })
      .mockResolvedValueOnce({
        id: conflict.id,
        local_json: JSON.stringify(conflict.localSnapshot),
        server_json: JSON.stringify({
          ...conflict.serverSnapshot,
          revision: conflict.serverSnapshot.revision + 1,
        }),
      });

    await expect(resolveConflict(conflict, "server", session)).rejects.toThrow(
      "Konflik berubah saat diproses",
    );
    expect(mockRunAsync).not.toHaveBeenCalled();
  });

  it("uses the new full-value session when retrying a legacy Sandbox correction", async () => {
    const upgraded: Session = {
      ...session,
      sessionId: "upgraded-session",
      dataMode: "sandbox",
      sandboxGeneration: 1,
      protocolVersion: 3,
      sandboxQrisPolicy: "transaction_total",
    };
    setModeFromSession(upgraded);
    const legacy = {
      ...conflict,
      localSnapshot: {
        ...conflict.localSnapshot,
        paymentMethod: "qris" as const,
        qrisPayloadHash: QRIS_PAYLOAD_HASH,
        paymentAmount: 1000,
      },
    };
    const original = JSON.stringify({
      ...correctionOperation,
      payload: {
        ...correctionOperation.payload,
        paymentMethod: "qris",
        qrisPayloadHash: QRIS_PAYLOAD_HASH,
      },
    });
    mockGetFirstAsync
      .mockResolvedValueOnce({
        operation_id: "legacy-operation",
        operation_json: original,
      })
      .mockResolvedValueOnce({ operation_json: original })
      .mockResolvedValueOnce({
        id: legacy.id,
        local_json: JSON.stringify(legacy.localSnapshot),
        server_json: JSON.stringify(legacy.serverSnapshot),
      });
    await resolveConflict(legacy, "retry-local", upgraded);
    const revision = mockRunAsync.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO transaction_revisions"),
    );
    expect(JSON.parse(String(revision?.[5]))).toMatchObject({
      paymentAmount: 70000,
      paymentStatus: "pending",
      paymentConfirmedRevision: null,
    });
    const queued = mockRunAsync.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO outbox_operations"),
    );
    expect(JSON.parse(String(queued?.[6]))).toMatchObject({
      originSessionId: upgraded.sessionId,
    });
    expect(legacy.localSnapshot.paymentAmount).toBe(1000);
  });

  it("blocks a new Sandbox conflict retry under a legacy session before changing evidence", async () => {
    const legacy: Session = {
      ...session,
      dataMode: "sandbox",
      sandboxGeneration: 1,
    };
    setModeFromSession(legacy);
    await expect(
      resolveConflict(conflict, "retry-local", legacy),
    ).rejects.toThrow("Sesi Mode Uji perlu diperbarui");
    expect(mockRunAsync).not.toHaveBeenCalled();
    expect(mockGetFirstAsync).not.toHaveBeenCalled();
  });

  it("archives a locally created transaction rejected by the server", async () => {
    const rejectedCreate = {
      aggregate: "transaction",
      action: "create",
      dependency_key: row.id,
      base_revision: null,
      occurred_at: row.occurred_at,
    };
    mockGetFirstAsync.mockResolvedValueOnce(rejectedCreate);

    await discardRejectedOutboxOperation("operation-1", session);

    const archiveCall = mockRunAsync.mock.calls.find(([sql]) =>
      String(sql).includes("deleted_at = COALESCE"),
    );
    expect(archiveCall?.[2]).toBe(row.id);
    const resolvedCall = mockRunAsync.mock.calls.find(([sql]) =>
      String(sql).includes("state = 'resolved'"),
    );
    expect(resolvedCall?.[1]).toBe(row.id);
  });

  it("refuses to archive a rejected create that has print evidence", async () => {
    const rejectedCreate = {
      aggregate: "transaction",
      action: "create",
      dependency_key: row.id,
      base_revision: null,
      occurred_at: row.occurred_at,
    };
    mockGetFirstAsync
      .mockResolvedValueOnce(rejectedCreate)
      .mockResolvedValueOnce({
        payment_status: "pending",
        has_print_attempt: 1,
      });

    await expect(
      discardRejectedOutboxOperation("operation-1", session),
    ).rejects.toThrow("tidak boleh diarsipkan otomatis");

    expect(mockRunAsync).not.toHaveBeenCalled();
  });

  it("refuses to archive a rejected create with historical success evidence", async () => {
    const rejectedCreate = {
      aggregate: "transaction",
      action: "create",
      dependency_key: row.id,
      base_revision: null,
      occurred_at: row.occurred_at,
    };
    mockGetFirstAsync
      .mockResolvedValueOnce(rejectedCreate)
      .mockResolvedValueOnce({
        payment_status: "pending",
        has_print_attempt: 0,
        has_success_audit: 1,
      });

    await expect(
      discardRejectedOutboxOperation("operation-1", session),
    ).rejects.toThrow("tidak boleh diarsipkan otomatis");

    expect(mockRunAsync).not.toHaveBeenCalled();
  });

  it("rolls a rejected transaction chain back in inverse order and removes its artifacts", async () => {
    const beforeCorrection: Transaction = {
      ...transaction,
      revision: 1,
      syncState: "synced" as const,
    };
    const rejectedCorrection = {
      operation_id: "operation-correction",
      aggregate: "transaction",
      action: "correct",
      dependency_key: row.id,
      base_revision: 1,
      occurred_at: row.occurred_at,
      last_error: "Koreksi ditolak.",
      queue_order: 1,
      has_conflict: 0,
    };
    const rejectedPayment = {
      operation_id: "operation-payment",
      aggregate: "transaction",
      action: "set_payment_status",
      dependency_key: row.id,
      base_revision: 2,
      occurred_at: "2026-07-29T00:01:00.000Z",
      last_error: "Operasi lanjutan dibatalkan.",
      queue_order: 2,
      has_conflict: 0,
    };
    mockGetFirstAsync
      .mockResolvedValueOnce(rejectedCorrection)
      .mockResolvedValueOnce({
        payload_json: JSON.stringify({
          before: transaction,
          after: {
            ...transaction,
            paymentStatus: "success",
            paymentConfirmedRevision: transaction.revision,
          },
        }),
      })
      .mockResolvedValueOnce({
        before_json: JSON.stringify(beforeCorrection),
      });
    mockGetAllAsync.mockResolvedValueOnce([
      rejectedCorrection,
      rejectedPayment,
    ]);

    await discardRejectedOutboxOperation("operation-1", session);

    const restoreCalls = mockRunAsync.mock.calls.filter(([sql]) =>
      String(sql).includes("ON CONFLICT(id) DO UPDATE"),
    );
    expect(restoreCalls.map((call) => call[2])).toEqual([2, 1]);
    expect(restoreCalls.map((call) => call[11])).toEqual(["synced", "synced"]);

    const cleanupCalls = mockRunAsync.mock.calls.filter(([sql]) =>
      String(sql).includes("revision > ?"),
    );
    expect(cleanupCalls.map((call) => call.slice(1))).toEqual([
      [row.id, beforeCorrection.revision],
      [row.id, beforeCorrection.revision],
    ]);
  });

  it("restores the prior payment status after a rejected payment mutation", async () => {
    const rejectedPayment = {
      operation_id: "operation-1",
      aggregate: "transaction",
      action: "set_payment_status",
      dependency_key: row.id,
      base_revision: row.revision,
      occurred_at: row.occurred_at,
      last_error: "Pembayaran ditolak.",
      queue_order: 1,
      has_conflict: 0,
    };
    mockGetFirstAsync
      .mockResolvedValueOnce(rejectedPayment)
      .mockResolvedValueOnce({
        payload_json: JSON.stringify({
          before: {
            ...transaction,
            paymentStatus: "failed",
            paymentConfirmedRevision: null,
          },
          after: {
            ...transaction,
            paymentStatus: "success",
            paymentConfirmedRevision: transaction.revision,
          },
        }),
      });
    mockGetAllAsync.mockResolvedValueOnce([rejectedPayment]);

    await discardRejectedOutboxOperation("operation-1", session);

    const restoreCall = mockRunAsync.mock.calls.find(([sql]) =>
      String(sql).includes("ON CONFLICT(id) DO UPDATE"),
    );
    expect(restoreCall?.[1]).toBe(row.id);
    expect(restoreCall?.[2]).toBe(row.revision);
    expect(restoreCall?.[11]).toBe("synced");
    expect(restoreCall?.[14]).toBe("failed");
    expect(restoreCall?.[15]).toBeNull();
  });

  it("counts only payments confirmed for their current revision in dashboard SQL", async () => {
    mockGetFirstAsync.mockResolvedValueOnce({
      gross: 170_000,
      transaction_count: 2,
    });
    mockGetAllAsync
      .mockResolvedValueOnce([
        { name: "Paket Standar", quantity: 3, accent: "standard" },
      ])
      .mockResolvedValueOnce([
        { bucket: 0, amount: 70_000 },
        { bucket: 23, amount: 100_000 },
      ]);

    const requestedRange = {
      mode: "date" as const,
      from: "2026-07-28T17:00:00.000Z",
      to: "2026-07-29T17:00:00.000Z",
    };
    const stats = await getDashboardStats(requestedRange);

    const sql = [...mockGetFirstAsync.mock.calls, ...mockGetAllAsync.mock.calls]
      .map(([query]) => String(query))
      .join("\n");
    expect(sql.match(/payment_status = 'success'/g)).toHaveLength(3);
    expect(
      sql.match(/payment_confirmed_revision = (?:t\.)?revision/g),
    ).toHaveLength(3);
    expect(mockGetFirstAsync).toHaveBeenCalledWith(
      expect.any(String),
      requestedRange.from,
      requestedRange.to,
    );
    expect(mockGetAllAsync).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      requestedRange.from,
      requestedRange.to,
    );
    expect(mockGetAllAsync).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      requestedRange.from,
      60 * 60,
      requestedRange.from,
      requestedRange.to,
    );
    expect(stats).toMatchObject({
      gross: 170_000,
      transactionCount: 2,
      quantities: [{ name: "Paket Standar", quantity: 3, accent: "standard" }],
    });
    expect(stats.buckets).toHaveLength(24);
    expect(stats.buckets[0]).toBe(70_000);
    expect(stats.buckets[23]).toBe(100_000);
  });
});
