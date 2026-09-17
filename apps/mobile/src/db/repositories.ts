import * as Crypto from "expo-crypto";
import type { SQLiteDatabase } from "expo-sqlite";

import type {
  DashboardStats,
  LocalScope,
  PaymentMethod,
  PaymentStatus,
  PrintState,
  QrisPayloadHash,
  RentalPackage,
  SelectablePaymentMethod,
  Session,
  SyncConflict,
  SyncState,
  Transaction,
  TransactionDraftLine,
  TransactionItem,
} from "@/domain/types";
import {
  assertSandboxSessionCurrent,
  resolvePaymentAmount,
} from "@/domain/payments";
import {
  canCorrectTransaction,
  canManageTransactionPayment,
  CORRECTION_FORBIDDEN_MESSAGE,
  PAYMENT_FORBIDDEN_MESSAGE,
} from "@/domain/permissions";
import {
  normalizeQrisPayloadHash,
  validateQrisAmount,
  validateQrisPayloadBinding,
} from "@/domain/qris";
import {
  beginLocalMutation,
  isLocalMutationLeaseActive,
} from "@/mode/mutation-barrier";
import { receiptProfileForSession } from "@/tenant/configuration";
import {
  getOrCreateTerminalIdentity,
  signCanonicalPayload,
} from "@/security/terminal-identity";
import { canonicalize } from "@/utils/canonical-json";
import { normalizeUtcTimestamp, type ReportingRange } from "@/utils/time";

import { getDatabase } from "./client";
import { createUlid } from "./ids";

const PAYMENT_CONFLICT_ERROR_PREFIX = "PAYMENT_STATE_CONFLICT: ";

async function withLocalMutation<T>(
  session: Session,
  mutation: () => Promise<T>,
): Promise<T> {
  const release = beginLocalMutation(session);
  try {
    return await mutation();
  } finally {
    release();
  }
}

interface TransactionRow {
  id: string;
  revision: number;
  occurred_at: string;
  subtotal: number;
  total: number;
  payment_amount: number;
  origin_actor_id: string;
  origin_actor_name: string;
  updated_actor_name: string;
  terminal_id: string;
  sync_state: SyncState;
  print_state: PrintState;
  payment_method: PaymentMethod;
  payment_status: PaymentStatus;
  payment_confirmed_revision: number | null;
  qris_payload_hash: string | null;
  deleted_at: string | null;
  receipt_identity_json?: string | null;
}

interface TransactionItemRow {
  id: string;
  package_id: string;
  package_revision: number;
  name: string;
  description: string;
  accent: RentalPackage["accent"];
  unit_price: number;
  quantity: number;
  line_total: number;
}

interface PackageRow {
  id: string;
  revision: number;
  name: string;
  description: string;
  unit_price: number;
  accent: RentalPackage["accent"];
  active: number;
  deleted_at: string | null;
}

export interface HistoryFilter {
  search?: string;
  syncState?: SyncState;
  from?: string;
  to?: string;
  packageId?: string;
  creatorId?: string;
  beforeOccurredAt?: string;
  beforeId?: string;
  limit?: number;
  offset?: number;
}

export interface HistoryFilterOption {
  id: string;
  label: string;
}

export interface StoredOutboxOperation {
  operationId: string;
  aggregateId: string;
  operation: Record<string, unknown>;
  signature: string;
  attempts: number;
}

export interface RejectedOutboxOperation {
  operationId: string;
  aggregateId: string;
  aggregate: string;
  action: string;
  message: string;
}

export type PrintAttemptResult = "pending" | "success" | "failed" | "unknown";

export async function listPackages(
  includeInactive = false,
  scope?: LocalScope,
): Promise<RentalPackage[]> {
  const { sqlite } = await getDatabase(scope);
  const rows = await sqlite.getAllAsync<PackageRow>(
    `SELECT * FROM packages_local
     WHERE deleted_at IS NULL ${includeInactive ? "" : "AND active = 1"}
     ORDER BY CASE accent WHEN 'standard' THEN 0 WHEN 'sunrise' THEN 1 ELSE 2 END,
              name`,
  );
  return rows.map(mapPackage);
}

export function upsertPackage(
  value: RentalPackage,
  session: Session,
): Promise<void> {
  return withLocalMutation(session, async () => {
    const { sqlite } = await getDatabase(session);
    await upsertPackageWithDatabase(sqlite, value);
  });
}

async function upsertPackageWithDatabase(
  database: SQLiteDatabase,
  value: RentalPackage,
): Promise<void> {
  await database.runAsync(
    `INSERT INTO packages_local(
      id, revision, name, description, unit_price, accent, active, deleted_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      revision = excluded.revision,
      name = excluded.name,
      description = excluded.description,
      unit_price = excluded.unit_price,
      accent = excluded.accent,
      active = excluded.active,
      deleted_at = excluded.deleted_at,
      updated_at = excluded.updated_at
    WHERE excluded.revision >= packages_local.revision`,
    value.id,
    value.revision,
    value.name,
    value.description,
    value.unitPrice,
    value.accent,
    value.active ? 1 : 0,
    value.deletedAt,
    new Date().toISOString(),
  );
}

export function createTransaction(
  lines: TransactionDraftLine[],
  paymentMethod: SelectablePaymentMethod,
  qrisPayloadHash: QrisPayloadHash | null,
  session: Session,
): Promise<Transaction> {
  return withLocalMutation(session, () =>
    createTransactionLocal(lines, paymentMethod, qrisPayloadHash, session),
  );
}

async function createTransactionLocal(
  lines: TransactionDraftLine[],
  paymentMethod: SelectablePaymentMethod,
  qrisPayloadHash: QrisPayloadHash | null,
  session: Session,
): Promise<Transaction> {
  const selected = lines.filter((line) => line.quantity > 0);
  assertSandboxSessionCurrent(session);
  if (selected.length === 0) {
    throw new Error("Pilih minimal satu paket.");
  }
  if (selected.some((line) => line.quantity < 1 || line.quantity > 999)) {
    throw new Error("Jumlah paket harus antara 1 dan 999.");
  }
  if (paymentMethod !== "cash" && paymentMethod !== "qris") {
    throw new Error("Pilih metode pembayaran tunai atau QRIS.");
  }
  const boundQrisPayloadHash = validateQrisPayloadBinding(
    paymentMethod,
    qrisPayloadHash,
  );

  const occurredAt = new Date().toISOString();
  const id = createUlid();
  const terminal = await getOrCreateTerminalIdentity(
    session.tenantId ?? undefined,
  );
  if (!terminal.serverTerminalId) {
    throw new Error("Terminal harus didaftarkan sebelum membuat transaksi.");
  }
  const items: TransactionItem[] = selected.map((line) => ({
    id: `ITEM-${createUlid()}`,
    packageId: line.package.id,
    packageRevision: line.package.revision,
    name: line.package.name,
    description: line.package.description,
    accent: line.package.accent,
    unitPrice: line.package.unitPrice,
    quantity: line.quantity,
    lineTotal: line.quantity * line.package.unitPrice,
  }));
  const total = items.reduce((sum, item) => sum + item.lineTotal, 0);
  const paymentAmount = resolvePaymentAmount(
    session.dataMode,
    paymentMethod,
    total,
    session.sandboxQrisPolicy,
  );
  if (paymentMethod === "qris") validateQrisAmount(paymentAmount);
  const receiptIdentity = await receiptProfileForSession(session);
  const transaction: Transaction = {
    id,
    revision: 1,
    occurredAt,
    subtotal: total,
    total,
    paymentAmount,
    originActorId: session.user.id,
    originActorName: session.user.fullName,
    updatedActorName: session.user.fullName,
    terminalId: terminal.serverTerminalId,
    syncState: "pending",
    printState: "pending",
    paymentMethod,
    paymentStatus: "success",
    paymentConfirmedRevision: 1,
    qrisPayloadHash: boundQrisPayloadHash,
    deletedAt: null,
    items,
    receiptIdentity,
  };

  const operation = {
    operationId: Crypto.randomUUID(),
    aggregate: "transaction",
    aggregateId: id,
    action: "create",
    baseRevision: null,
    originSessionId: session.sessionId,
    originActorId: session.user.id,
    terminalId: terminal.serverTerminalId,
    occurredAt,
    payload: {
      id: transaction.id,
      paymentMethod: transaction.paymentMethod,
      receiptProfileRevision: receiptIdentity.revision,
      ...(transaction.qrisPayloadHash
        ? { qrisPayloadHash: transaction.qrisPayloadHash }
        : {}),
      items: toMutationItems(transaction.items),
    },
  };
  const signature = await signCanonicalPayload(
    operation,
    session.tenantId ?? undefined,
  );
  const auditId = `AUD-${createUlid()}`;
  const { sqlite } = await getDatabase(session);

  await sqlite.withTransactionAsync(async () => {
    await insertTransaction(sqlite, transaction);
    await insertRevision(sqlite, transaction, null, null, session);
    await sqlite.runAsync(
      `INSERT INTO audit_events(
        id, kind, aggregate_id, actor_id, session_id, terminal_id, payload_json, occurred_at
      ) VALUES (?, 'transaction.created', ?, ?, ?, ?, ?, ?)`,
      auditId,
      transaction.id,
      session.user.id,
      session.sessionId,
      terminal.serverTerminalId,
      JSON.stringify(transaction),
      occurredAt,
    );
    await insertOutbox(sqlite, operation, signature, transaction.id);
  });
  return transaction;
}

export function correctTransaction(
  transactionId: string,
  quantities: Record<string, number>,
  paymentMethod: SelectablePaymentMethod,
  qrisPayloadHash: QrisPayloadHash | null,
  reason: string,
  session: Session,
): Promise<Transaction> {
  return withLocalMutation(session, () =>
    correctTransactionLocal(
      transactionId,
      quantities,
      paymentMethod,
      qrisPayloadHash,
      reason,
      session,
    ),
  );
}

async function correctTransactionLocal(
  transactionId: string,
  quantities: Record<string, number>,
  paymentMethod: SelectablePaymentMethod,
  qrisPayloadHash: QrisPayloadHash | null,
  reason: string,
  session: Session,
): Promise<Transaction> {
  const before = await getTransaction(transactionId, session);
  await assertNoQuarantinedDependency(
    (await getDatabase(session)).sqlite,
    transactionId,
  );
  if (!before) throw new Error("Transaksi tidak ditemukan.");
  assertSandboxSessionCurrent(session);
  if (before.deletedAt) {
    throw new Error("Transaksi yang diarsipkan tidak dapat dikoreksi.");
  }
  if (before.syncState === "conflict") {
    throw new Error(
      "Selesaikan konflik revisi sebelum mengoreksi transaksi ini.",
    );
  }
  if (await hasTerminalTransactionBlock(transactionId, session)) {
    throw new Error(
      "Operasi transaksi ini ditolak server. Pulihkan data dari Pusat Sinkron sebelum membuat koreksi baru.",
    );
  }
  if (!canCorrectTransaction(session, before)) {
    throw new Error(CORRECTION_FORBIDDEN_MESSAGE);
  }
  if (reason.trim().length < 5) {
    throw new Error("Alasan koreksi minimal 5 karakter.");
  }
  if (paymentMethod !== "cash" && paymentMethod !== "qris") {
    throw new Error("Pilih metode pembayaran tunai atau QRIS.");
  }
  const boundQrisPayloadHash = validateQrisPayloadBinding(
    paymentMethod,
    qrisPayloadHash,
  );

  const items = before.items
    .map((item) => {
      const quantity = quantities[item.packageId] ?? item.quantity;
      return {
        ...item,
        id: `ITEM-${createUlid()}`,
        quantity,
        lineTotal: quantity * item.unitPrice,
      };
    })
    .filter((item) => item.quantity > 0);
  if (items.length === 0) throw new Error("Minimal satu item harus tersisa.");
  if (items.some((item) => item.quantity > 999)) {
    throw new Error("Jumlah paket maksimal 999.");
  }

  const terminal = await getOrCreateTerminalIdentity(
    session.tenantId ?? undefined,
  );
  if (!terminal.serverTerminalId) {
    throw new Error("Terminal belum terdaftar.");
  }
  const occurredAt = new Date().toISOString();
  const total = items.reduce((sum, item) => sum + item.lineTotal, 0);
  const paymentAmount = resolvePaymentAmount(
    session.dataMode,
    paymentMethod,
    total,
    session.sandboxQrisPolicy,
  );
  if (paymentMethod === "qris") validateQrisAmount(paymentAmount);
  const corrected: Transaction = {
    ...before,
    revision: before.revision + 1,
    subtotal: total,
    total,
    paymentAmount,
    updatedActorName: session.user.fullName,
    terminalId: terminal.serverTerminalId,
    syncState: "pending",
    printState:
      before.printState === "success" || before.printState === "needs-reprint"
        ? "needs-reprint"
        : before.printState,
    paymentMethod,
    paymentStatus: "success",
    paymentConfirmedRevision: before.revision + 1,
    qrisPayloadHash: boundQrisPayloadHash,
    items,
  };

  const operation = {
    operationId: Crypto.randomUUID(),
    aggregate: "transaction",
    aggregateId: before.id,
    action: "correct",
    baseRevision: before.revision,
    originSessionId: session.sessionId,
    originActorId: session.user.id,
    terminalId: terminal.serverTerminalId,
    occurredAt,
    payload: {
      id: corrected.id,
      reason: reason.trim(),
      paymentMethod: corrected.paymentMethod,
      ...(corrected.qrisPayloadHash
        ? { qrisPayloadHash: corrected.qrisPayloadHash }
        : {}),
      items: toMutationItems(corrected.items),
    },
  };
  const signature = await signCanonicalPayload(
    operation,
    session.tenantId ?? undefined,
  );
  const { sqlite } = await getDatabase(session);

  await sqlite.withTransactionAsync(async () => {
    await sqlite.runAsync(
      `UPDATE transactions SET
         revision = ?, subtotal = ?, total = ?, payment_amount = ?, updated_actor_name = ?,
         terminal_id = ?, sync_state = 'pending', print_state = ?,
         payment_method = ?, payment_status = 'success',
         payment_confirmed_revision = ?, qris_payload_hash = ?
       WHERE id = ?`,
      corrected.revision,
      corrected.subtotal,
      corrected.total,
      corrected.paymentAmount,
      corrected.updatedActorName,
      corrected.terminalId,
      corrected.printState,
      corrected.paymentMethod,
      corrected.paymentConfirmedRevision,
      corrected.qrisPayloadHash,
      corrected.id,
    );
    await insertItems(sqlite, corrected);
    await insertRevision(sqlite, corrected, reason.trim(), before, session);
    await sqlite.runAsync(
      `INSERT INTO audit_events(
        id, kind, aggregate_id, actor_id, session_id, terminal_id, payload_json, occurred_at
      ) VALUES (?, 'transaction.corrected', ?, ?, ?, ?, ?, ?)`,
      `AUD-${createUlid()}`,
      corrected.id,
      session.user.id,
      session.sessionId,
      terminal.serverTerminalId,
      JSON.stringify({ before, after: corrected, reason: reason.trim() }),
      occurredAt,
    );
    await insertOutbox(sqlite, operation, signature, corrected.id);
  });
  return corrected;
}

export function setPaymentStatus(
  transactionId: string,
  status: Exclude<PaymentStatus, "pending">,
  session: Session,
): Promise<Transaction> {
  return withLocalMutation(session, () =>
    setPaymentStatusLocal(transactionId, status, session),
  );
}

async function setPaymentStatusLocal(
  transactionId: string,
  status: Exclude<PaymentStatus, "pending">,
  session: Session,
): Promise<Transaction> {
  const before = await getTransaction(transactionId, session);
  await assertNoQuarantinedDependency(
    (await getDatabase(session)).sqlite,
    transactionId,
  );
  if (!before) throw new Error("Transaksi tidak ditemukan.");
  if (before.deletedAt) {
    throw new Error("Pembayaran transaksi yang diarsipkan tidak dapat diubah.");
  }
  if (before.syncState === "conflict") {
    throw new Error(
      "Selesaikan konflik revisi sebelum mengubah status pembayaran.",
    );
  }
  if (await hasTerminalTransactionBlock(transactionId, session)) {
    throw new Error(
      "Operasi transaksi ini ditolak server. Pulihkan data dari Pusat Sinkron sebelum mengubah pembayaran.",
    );
  }
  if (!canManageTransactionPayment(session, before)) {
    throw new Error(PAYMENT_FORBIDDEN_MESSAGE);
  }
  if (status !== "success" && status !== "failed") {
    throw new Error("Status pembayaran tidak valid.");
  }
  if (
    before.paymentStatus === "success" &&
    before.paymentConfirmedRevision === before.revision
  ) {
    if (status === "success") return before;
    throw new Error(
      "Pembayaran berhasil untuk revisi ini sudah final. Buat koreksi transaksi jika nilainya berubah.",
    );
  }
  if (before.paymentStatus === status && status === "failed") {
    return before;
  }

  const terminal = await getOrCreateTerminalIdentity(
    session.tenantId ?? undefined,
  );
  if (!terminal.serverTerminalId) {
    throw new Error("Terminal belum terdaftar.");
  }
  const occurredAt = new Date().toISOString();
  const updated: Transaction = {
    ...before,
    updatedActorName: session.user.fullName,
    terminalId: terminal.serverTerminalId,
    syncState: "pending",
    paymentStatus: status,
    paymentConfirmedRevision: status === "success" ? before.revision : null,
  };
  const operation = {
    operationId: Crypto.randomUUID(),
    aggregate: "transaction",
    aggregateId: before.id,
    action: "set_payment_status",
    baseRevision: before.revision,
    originSessionId: session.sessionId,
    originActorId: session.user.id,
    terminalId: terminal.serverTerminalId,
    occurredAt,
    payload: {
      id: before.id,
      status,
    },
  };
  const signature = await signCanonicalPayload(
    operation,
    session.tenantId ?? undefined,
  );
  const { sqlite } = await getDatabase(session);

  await sqlite.withTransactionAsync(async () => {
    await sqlite.runAsync(
      `UPDATE transactions SET
         updated_actor_name = ?, terminal_id = ?, sync_state = 'pending',
         payment_status = ?, payment_confirmed_revision = ?
       WHERE id = ?`,
      updated.updatedActorName,
      updated.terminalId,
      updated.paymentStatus,
      updated.paymentConfirmedRevision,
      updated.id,
    );
    await sqlite.runAsync(
      `INSERT INTO audit_events(
        id, kind, aggregate_id, actor_id, session_id, terminal_id, payload_json, occurred_at
      ) VALUES (?, 'payment.status_changed', ?, ?, ?, ?, ?, ?)`,
      `AUD-${createUlid()}`,
      updated.id,
      session.user.id,
      session.sessionId,
      terminal.serverTerminalId,
      JSON.stringify({ before, after: updated }),
      occurredAt,
    );
    await insertOutbox(sqlite, operation, signature, updated.id);
  });
  return updated;
}

export async function getTransaction(
  id: string,
  mode?: LocalScope,
): Promise<Transaction | null> {
  const { sqlite } = await getDatabase(mode);
  const row = await sqlite.getFirstAsync<TransactionRow>(
    "SELECT * FROM transactions WHERE id = ?",
    id,
  );
  if (!row) return null;
  return hydrateTransaction(sqlite, row);
}

export async function listTransactions(
  filter: HistoryFilter = {},
  scope?: LocalScope,
): Promise<Transaction[]> {
  const { sqlite } = await getDatabase(scope);
  const clauses = ["deleted_at IS NULL"];
  const params: (string | number)[] = [];

  if (filter.search?.trim()) {
    clauses.push("(id LIKE ? OR origin_actor_name LIKE ?)");
    const normalized = filter.search.trim().replace(/^(?:TEST-)?TRX-/i, "");
    const search = `%${normalized}%`;
    params.push(search, search);
  }
  if (filter.syncState) {
    clauses.push("sync_state = ?");
    params.push(filter.syncState);
  }
  if (filter.from) {
    clauses.push("occurred_at >= ?");
    params.push(filter.from);
  }
  if (filter.to) {
    clauses.push("occurred_at < ?");
    params.push(filter.to);
  }
  if (filter.packageId) {
    clauses.push(
      `EXISTS (
        SELECT 1 FROM transaction_items filter_item
        WHERE filter_item.transaction_id = transactions.id
          AND filter_item.revision = transactions.revision
          AND filter_item.package_id = ?
      )`,
    );
    params.push(filter.packageId);
  }
  if (filter.creatorId) {
    clauses.push("origin_actor_id = ?");
    params.push(filter.creatorId);
  }
  if (filter.beforeOccurredAt && filter.beforeId) {
    clauses.push("(occurred_at < ? OR (occurred_at = ? AND id < ?))");
    params.push(
      filter.beforeOccurredAt,
      filter.beforeOccurredAt,
      filter.beforeId,
    );
  }
  params.push(filter.limit ?? 30, filter.offset ?? 0);

  const rows = await sqlite.getAllAsync<TransactionRow>(
    `SELECT * FROM transactions
     WHERE ${clauses.join(" AND ")}
     ORDER BY occurred_at DESC, id DESC
     LIMIT ? OFFSET ?`,
    ...params,
  );
  return Promise.all(rows.map((row) => hydrateTransaction(sqlite, row)));
}

export async function listHistoryPackageOptions(
  scope?: LocalScope,
): Promise<HistoryFilterOption[]> {
  const { sqlite } = await getDatabase(scope);
  const rows = await sqlite.getAllAsync<{ id: string; label: string }>(
    `SELECT i.package_id AS id, MAX(i.name) AS label
     FROM transaction_items i
     JOIN transactions t
       ON t.id = i.transaction_id AND t.revision = i.revision
     WHERE t.deleted_at IS NULL
     GROUP BY i.package_id
     ORDER BY label`,
  );
  return rows;
}

export async function listHistoryCreatorOptions(
  scope?: LocalScope,
): Promise<HistoryFilterOption[]> {
  const { sqlite } = await getDatabase(scope);
  return sqlite.getAllAsync<{ id: string; label: string }>(
    `SELECT origin_actor_id AS id, MAX(origin_actor_name) AS label
     FROM transactions
     WHERE deleted_at IS NULL
     GROUP BY origin_actor_id
     ORDER BY label`,
  );
}

export async function getDashboardStats(
  range: ReportingRange,
  scope?: LocalScope,
): Promise<DashboardStats> {
  const { sqlite } = await getDatabase(scope);
  const total = await sqlite.getFirstAsync<{
    gross: number | null;
    actual_qris_amount: number | null;
    transaction_count: number;
  }>(
    `SELECT COALESCE(SUM(total), 0) AS gross,
            COALESCE(SUM(CASE WHEN payment_method = 'qris' THEN payment_amount ELSE 0 END), 0)
              AS actual_qris_amount,
            COUNT(*) AS transaction_count
     FROM transactions
     WHERE deleted_at IS NULL
       AND payment_status = 'success'
       AND payment_confirmed_revision = revision
       AND occurred_at >= ? AND occurred_at < ?`,
    range.from,
    range.to,
  );
  const quantities = await sqlite.getAllAsync<{
    name: string;
    quantity: number;
    accent: string;
  }>(
    `SELECT i.name, SUM(i.quantity) AS quantity,
            i.accent
     FROM transaction_items i
     JOIN transactions t ON t.id = i.transaction_id AND t.revision = i.revision
     WHERE t.deleted_at IS NULL
       AND t.payment_status = 'success'
       AND t.payment_confirmed_revision = t.revision
       AND t.occurred_at >= ? AND t.occurred_at < ?
     GROUP BY i.package_id, i.name, i.accent
     ORDER BY quantity DESC`,
    range.from,
    range.to,
  );
  const bucketSeconds = range.mode === "date" ? 60 * 60 : 24 * 60 * 60;
  const bucketCount =
    range.mode === "date"
      ? 24
      : Math.round(
          (new Date(range.to).getTime() - new Date(range.from).getTime()) /
            (24 * 60 * 60 * 1000),
        );
  const trendRows = await sqlite.getAllAsync<{
    bucket: number;
    amount: number;
  }>(
    `SELECT
       CAST(
         (strftime('%s', occurred_at) - strftime('%s', ?)) / ?
         AS INTEGER
       ) AS bucket,
     SUM(total) AS amount
     FROM transactions
     WHERE deleted_at IS NULL
       AND payment_status = 'success'
       AND payment_confirmed_revision = revision
       AND occurred_at >= ? AND occurred_at < ?
     GROUP BY bucket
     ORDER BY bucket`,
    range.from,
    bucketSeconds,
    range.from,
    range.to,
  );
  const buckets = Array<number>(bucketCount).fill(0);
  for (const row of trendRows) {
    if (row.bucket >= 0 && row.bucket < buckets.length) {
      buckets[row.bucket] = row.amount;
    }
  }

  return {
    gross: total?.gross ?? 0,
    actualQrisAmount: total?.actual_qris_amount ?? 0,
    transactionCount: total?.transaction_count ?? 0,
    quantities,
    buckets,
  };
}

interface BeginPrintAttemptInput {
  transactionId: string;
  transactionRevision: number;
  adapter: string;
  isCopy: boolean;
  session: Session;
  mutationLease?: (() => void) | undefined;
}

export function beginPrintAttempt(
  input: BeginPrintAttemptInput,
): Promise<string> {
  if (input.mutationLease && isLocalMutationLeaseActive(input.mutationLease))
    return beginPrintAttemptLocal(input);
  return withLocalMutation(input.session, () => beginPrintAttemptLocal(input));
}

async function beginPrintAttemptLocal(
  input: BeginPrintAttemptInput,
): Promise<string> {
  const transaction = await getTransaction(input.transactionId, input.session);
  if (!transaction) throw new Error("Transaksi tidak ditemukan.");
  if (transaction.deletedAt) {
    throw new Error("Transaksi yang diarsipkan tidak dapat dicetak.");
  }
  if (transaction.syncState === "conflict") {
    throw new Error(
      "Selesaikan konflik revisi sebelum mencetak transaksi ini.",
    );
  }
  if (await hasTerminalTransactionBlock(input.transactionId, input.session)) {
    throw new Error(
      "Operasi transaksi ini ditolak server dan belum dipulihkan. Pencetakan dikunci.",
    );
  }
  if (transaction.revision !== input.transactionRevision) {
    throw new Error(
      "Transaksi berubah sebelum pencetakan dimulai. Muat ulang detail transaksi.",
    );
  }
  if (
    transaction.paymentStatus !== "success" ||
    transaction.paymentConfirmedRevision !== transaction.revision
  ) {
    throw new Error(
      "Pembayaran harus berhasil untuk revisi transaksi saat ini sebelum struk dapat dicetak.",
    );
  }
  const attemptId = Crypto.randomUUID();
  const now = new Date().toISOString();
  const { sqlite } = await getDatabase(input.session);
  await assertNoQuarantinedDependency(sqlite, input.transactionId);
  await sqlite.runAsync(
    `INSERT INTO print_attempts(
      id, transaction_id, transaction_revision, adapter, is_copy,
      requested_at, completed_at, result, error
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', NULL)`,
    attemptId,
    input.transactionId,
    input.transactionRevision,
    input.adapter,
    input.isCopy ? 1 : 0,
    now,
  );
  return attemptId;
}

interface CompletePrintAttemptInput {
  attemptId: string;
  transactionId: string;
  result: Exclude<PrintAttemptResult, "pending">;
  error?: string;
  session: Session;
  mutationLease?: (() => void) | undefined;
}

export function completePrintAttempt(
  input: CompletePrintAttemptInput,
): Promise<void> {
  if (input.mutationLease && isLocalMutationLeaseActive(input.mutationLease))
    return completePrintAttemptLocal(input);
  return withLocalMutation(input.session, () =>
    completePrintAttemptLocal(input),
  );
}

async function completePrintAttemptLocal(
  input: CompletePrintAttemptInput,
): Promise<void> {
  const terminal = await getOrCreateTerminalIdentity(
    input.session.tenantId ?? undefined,
  );
  if (!terminal.serverTerminalId) throw new Error("Terminal belum terdaftar.");
  const now = new Date().toISOString();
  const { sqlite } = await getDatabase(input.session);
  const attempt = await sqlite.getFirstAsync<{
    transaction_id: string;
    adapter: string;
    is_copy: number;
    transaction_revision: number | null;
  }>(
    `SELECT transaction_id, adapter, is_copy, transaction_revision
     FROM print_attempts WHERE id = ?`,
    input.attemptId,
  );
  if (!attempt) throw new Error("Upaya cetak tidak ditemukan.");
  if (attempt.transaction_id !== input.transactionId) {
    throw new Error("Upaya cetak tidak sesuai dengan transaksi.");
  }
  if (
    !Number.isInteger(attempt.transaction_revision) ||
    (attempt.transaction_revision ?? 0) < 1
  ) {
    throw new Error("Revisi transaksi pada upaya cetak tidak valid.");
  }
  const operation = {
    operationId: Crypto.randomUUID(),
    aggregate: "print_attempt",
    aggregateId: input.attemptId,
    action: "create",
    baseRevision: null,
    originSessionId: input.session.sessionId,
    originActorId: input.session.user.id,
    terminalId: terminal.serverTerminalId,
    occurredAt: now,
    payload: {
      id: input.attemptId,
      transactionId: attempt.transaction_id,
      transactionRevision: attempt.transaction_revision,
      status: input.result,
      isCopy: attempt.is_copy === 1,
      printerKind: attempt.adapter,
      printerIdentifier: null,
      errorCode: input.result === "failed" ? "PRINT_FAILED" : null,
      errorMessage: input.error ?? null,
      metadata: {},
    },
  };
  const signature = await signCanonicalPayload(
    operation,
    input.session.tenantId ?? undefined,
  );
  await sqlite.withTransactionAsync(async () => {
    await sqlite.runAsync(
      `UPDATE print_attempts
       SET completed_at = ?, result = ?, error = ?
       WHERE id = ?`,
      now,
      input.result,
      input.error ?? null,
      input.attemptId,
    );
    await sqlite.runAsync(
      `UPDATE transactions
       SET print_state = ?
       WHERE id = ? AND revision = ?`,
      input.result,
      attempt.transaction_id,
      attempt.transaction_revision,
    );
    await sqlite.runAsync(
      `INSERT INTO audit_events(
        id, kind, aggregate_id, actor_id, session_id, terminal_id, payload_json, occurred_at
      ) VALUES (?, 'print.completed', ?, ?, ?, ?, ?, ?)`,
      `AUD-${createUlid()}`,
      attempt.transaction_id,
      input.session.user.id,
      input.session.sessionId,
      terminal.serverTerminalId,
      JSON.stringify(operation.payload),
      now,
    );
    await insertOutbox(sqlite, operation, signature, attempt.transaction_id);
  });
}

export async function recoverInterruptedPrintAttempts(
  session: Session,
): Promise<number> {
  const { sqlite } = await getDatabase(session);
  const pending = await sqlite.getAllAsync<{
    id: string;
    transaction_id: string;
  }>(
    `SELECT id, transaction_id FROM print_attempts
     WHERE result = 'pending' ORDER BY requested_at`,
  );
  for (const attempt of pending) {
    await completePrintAttempt({
      attemptId: attempt.id,
      transactionId: attempt.transaction_id,
      result: "unknown",
      error: "Aplikasi berhenti sebelum hasil cetak dapat dikonfirmasi.",
      session,
    });
  }
  return pending.length;
}

export async function getOutboxOperations(
  limit = 25,
  mode?: LocalScope,
): Promise<StoredOutboxOperation[]> {
  const { sqlite } = await getDatabase(mode);
  const rows = await sqlite.getAllAsync<{
    operation_id: string;
    aggregate_id: string;
    operation_json: string;
    signature: string;
    attempts: number;
  }>(
    `SELECT
       candidate.operation_id,
       candidate.aggregate_id,
       candidate.operation_json,
       candidate.signature,
       candidate.attempts
     FROM outbox_operations candidate
     WHERE candidate.state IN ('pending', 'error')
       AND candidate.quarantine_reason IS NULL
       AND (
         candidate.next_attempt_at IS NULL
         OR candidate.next_attempt_at <= ?
       )
       AND NOT EXISTS (
         SELECT 1
         FROM outbox_operations predecessor
         WHERE predecessor.dependency_key = candidate.dependency_key
           AND (
             predecessor.state IN ('pending', 'error', 'conflict', 'rejected')
             OR (
               predecessor.state = 'discarded'
               AND predecessor.last_error IS NOT NULL
             )
           )
           AND predecessor.rowid < candidate.rowid
       )
     ORDER BY candidate.rowid ASC
     LIMIT ?`,
    new Date().toISOString(),
    limit,
  );
  return rows.map((row) => ({
    operationId: row.operation_id,
    aggregateId: row.aggregate_id,
    operation: JSON.parse(row.operation_json) as Record<string, unknown>,
    signature: row.signature,
    attempts: row.attempts,
  }));
}

export async function markOutboxResult(
  operationId: string,
  aggregateId: string,
  result:
    | { kind: "success" }
    | { kind: "error"; message: string }
    | { kind: "rejected"; message: string }
    | {
        kind: "payment-conflict";
        message: string;
        paymentStatus: PaymentStatus;
        paymentConfirmedRevision: number | null;
        authoritative: Transaction;
      }
    | { kind: "conflict"; local: Transaction; server: Transaction },
  mode?: LocalScope,
): Promise<void> {
  const { sqlite } = await getDatabase(mode);
  await sqlite.withTransactionAsync(async () => {
    const operation = await sqlite.getFirstAsync<{
      dependency_key: string | null;
      aggregate: string;
      action: string;
      operation_json: string;
    }>(
      `SELECT dependency_key, aggregate, action, operation_json
       FROM outbox_operations WHERE operation_id = ?`,
      operationId,
    );
    const dependencyKey = operation?.dependency_key ?? aggregateId;
    const preserveRejectedCreateEvidence =
      result.kind === "rejected" &&
      operation?.aggregate === "transaction" &&
      (await shouldPreserveRejectedCreateEvidence(
        sqlite,
        dependencyKey,
        operationId,
        operation.action,
      ));
    if (result.kind === "success") {
      await sqlite.runAsync(
        "UPDATE outbox_operations SET state = 'synced', last_error = NULL WHERE operation_id = ?",
        operationId,
      );
      await sqlite.runAsync(
        `UPDATE transactions
         SET sync_state = CASE
           WHEN EXISTS (
             SELECT 1
             FROM outbox_operations
             WHERE dependency_key = ?
               AND state IN ('pending', 'error', 'conflict', 'rejected')
           ) THEN 'pending'
           ELSE 'synced'
         END
         WHERE id = ?`,
        dependencyKey,
        dependencyKey,
      );
      return;
    }
    if (result.kind === "error") {
      await sqlite.runAsync(
        `UPDATE outbox_operations SET
          state = 'error', attempts = attempts + 1, last_error = ?,
          next_attempt_at = ?
         WHERE operation_id = ?`,
        result.message,
        new Date(Date.now() + 30_000).toISOString(),
        operationId,
      );
      await sqlite.runAsync(
        "UPDATE transactions SET sync_state = 'error' WHERE id = ?",
        dependencyKey,
      );
      return;
    }
    if (result.kind === "rejected" || result.kind === "payment-conflict") {
      const rejectionMessage =
        result.kind === "payment-conflict"
          ? `${PAYMENT_CONFLICT_ERROR_PREFIX}${result.message}`
          : result.message;
      await sqlite.runAsync(
        `UPDATE outbox_operations SET
           state = 'rejected', attempts = attempts + 1,
           last_error = ?, next_attempt_at = NULL
         WHERE operation_id = ?`,
        rejectionMessage,
        operationId,
      );
      if (result.kind === "payment-conflict") {
        const authoritative: Transaction = {
          ...result.authoritative,
          syncState: "error",
          paymentStatus: result.paymentStatus,
          paymentConfirmedRevision: result.paymentConfirmedRevision,
        };
        await replaceTransaction(sqlite, authoritative);
        const signedOperation = parseOutboxOperation(operation?.operation_json);
        await sqlite.runAsync(
          `INSERT INTO audit_events(
             id, kind, aggregate_id, actor_id, session_id, terminal_id,
             payload_json, occurred_at
           ) VALUES (
             ?, 'sync.payment_conflict_authoritative', ?, ?, ?, ?, ?, ?
           )`,
          `AUD-${createUlid()}`,
          dependencyKey,
          signedOperation.originActorId,
          signedOperation.originSessionId,
          signedOperation.terminalId,
          JSON.stringify({
            operationId,
            authoritative,
          }),
          new Date().toISOString(),
        );
      } else if (
        operation?.aggregate === "transaction" &&
        (operation.action === "create" ||
          operation.action === "correct" ||
          operation.action === "set_payment_status")
      ) {
        if (!preserveRejectedCreateEvidence) {
          await sqlite.runAsync(
            `UPDATE transactions
             SET payment_status = 'pending',
                 payment_confirmed_revision = NULL,
                 sync_state = 'error'
             WHERE id = ?`,
            dependencyKey,
          );
        }
      }
      await sqlite.runAsync(
        `UPDATE outbox_operations
         SET state = 'rejected', attempts = attempts + 1,
             last_error = ?, next_attempt_at = NULL
         WHERE dependency_key = ?
           AND rowid > (
             SELECT rowid FROM outbox_operations WHERE operation_id = ?
           )
           AND state IN ('pending', 'error')`,
        `Operasi lanjutan dibatalkan karena operasi sebelumnya ditolak: ${result.message}`,
        dependencyKey,
        operationId,
      );
      await sqlite.runAsync(
        "UPDATE transactions SET sync_state = 'error' WHERE id = ?",
        dependencyKey,
      );
      return;
    }
    await sqlite.runAsync(
      "UPDATE outbox_operations SET state = 'conflict', last_error = 'REVISION_CONFLICT' WHERE operation_id = ?",
      operationId,
    );
    await sqlite.runAsync(
      `UPDATE outbox_operations
       SET state = 'rejected', attempts = attempts + 1,
           last_error = ?, next_attempt_at = NULL
       WHERE dependency_key = ?
         AND rowid > (
           SELECT rowid FROM outbox_operations WHERE operation_id = ?
         )
         AND state IN ('pending', 'error')`,
      "Operasi lanjutan dibatalkan karena koreksi sebelumnya berkonflik.",
      dependencyKey,
      operationId,
    );
    await sqlite.runAsync(
      `UPDATE transactions
       SET sync_state = 'conflict',
           payment_status = 'pending',
           payment_confirmed_revision = NULL
       WHERE id = ?`,
      dependencyKey,
    );
    await sqlite.runAsync(
      `INSERT INTO sync_conflicts(
        id, transaction_id, local_json, server_json, created_at
      ) VALUES (?, ?, ?, ?, ?)`,
      `CONFLICT-${createUlid()}`,
      dependencyKey,
      JSON.stringify(result.local),
      JSON.stringify(result.server),
      new Date().toISOString(),
    );
  });
}

export async function countPendingOutbox(mode?: LocalScope): Promise<number> {
  const { sqlite } = await getDatabase(mode);
  const row = await sqlite.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) AS count FROM outbox_operations WHERE state IN ('pending', 'error', 'conflict', 'rejected') AND quarantine_reason IS NULL",
  );
  return row?.count ?? 0;
}

export async function listRejectedOutboxOperations(
  scope?: LocalScope,
): Promise<RejectedOutboxOperation[]> {
  const { sqlite } = await getDatabase(scope);
  const rows = await sqlite.getAllAsync<{
    operation_id: string;
    aggregate_id: string;
    aggregate: string;
    action: string;
    last_error: string | null;
  }>(
    `SELECT
       candidate.operation_id,
       candidate.aggregate_id,
       candidate.aggregate,
       candidate.action,
       candidate.last_error
     FROM outbox_operations candidate
     WHERE candidate.state = 'rejected'
       AND candidate.quarantine_reason IS NULL
       AND NOT EXISTS (
         SELECT 1
         FROM outbox_operations unresolved
         WHERE unresolved.dependency_key = candidate.dependency_key
           AND unresolved.state = 'conflict'
       )
       AND NOT EXISTS (
         SELECT 1
         FROM outbox_operations predecessor
         WHERE predecessor.dependency_key = candidate.dependency_key
           AND predecessor.state = 'rejected'
           AND predecessor.rowid < candidate.rowid
       )
     ORDER BY candidate.rowid ASC`,
  );
  return rows.map((row) => ({
    operationId: row.operation_id,
    aggregateId: row.aggregate_id,
    aggregate: row.aggregate,
    action: row.action,
    message: stripPaymentConflictPrefix(
      row.last_error ?? "Operasi ditolak server.",
    ),
  }));
}

async function hasQuarantinedDependency(
  sqlite: SQLiteDatabase,
  transactionId: string,
): Promise<boolean> {
  const row = await sqlite.getFirstAsync<{ blocked: number }>(
    "SELECT EXISTS(SELECT 1 FROM outbox_operations WHERE dependency_key = ? AND quarantine_reason IS NOT NULL) AS blocked",
    transactionId,
  );
  return row?.blocked === 1;
}

async function assertNoQuarantinedDependency(
  sqlite: SQLiteDatabase,
  transactionId: string,
): Promise<void> {
  if (await hasQuarantinedDependency(sqlite, transactionId))
    throw new Error(
      "Transaksi memiliki bukti yang dikarantina. Pulihkan dan periksa izin akun asal sebelum mengubah atau mengarsipkannya.",
    );
}

export function discardRejectedOutboxOperation(
  operationId: string,
  session: Session,
): Promise<void> {
  return withLocalMutation(session, () =>
    discardRejectedOutboxOperationLocal(operationId, session),
  );
}

async function discardRejectedOutboxOperationLocal(
  operationId: string,
  session: Session,
): Promise<void> {
  const { sqlite } = await getDatabase(session);
  type RecoveryOperation = {
    operation_id: string;
    aggregate: string;
    action: string;
    dependency_key: string | null;
    base_revision: number | null;
    occurred_at: string;
    last_error: string | null;
    queue_order: number;
    has_conflict: number;
  };
  await sqlite.withTransactionAsync(async () => {
    const selected = await sqlite.getFirstAsync<RecoveryOperation>(
      `SELECT
         candidate.aggregate,
         candidate.action,
         candidate.operation_id,
         candidate.dependency_key,
         candidate.base_revision,
         candidate.occurred_at,
         candidate.last_error,
         candidate.rowid AS queue_order,
         EXISTS(
           SELECT 1
           FROM outbox_operations unresolved
           WHERE unresolved.dependency_key = candidate.dependency_key
             AND unresolved.state = 'conflict'
         ) AS has_conflict
       FROM outbox_operations candidate
       WHERE candidate.operation_id = ?
         AND candidate.quarantine_reason IS NULL
         AND candidate.state = 'rejected'`,
      operationId,
    );
    if (!selected) return;
    if (selected.has_conflict === 1) {
      throw new Error(
        "Selesaikan konflik revisi sebelum memulihkan operasi turunannya.",
      );
    }

    const transactionId = selected.dependency_key;
    if (transactionId)
      await assertNoQuarantinedDependency(sqlite, transactionId);
    if (selected.aggregate === "transaction" && transactionId) {
      const rows = await sqlite.getAllAsync<RecoveryOperation>(
        `SELECT
           aggregate,
           action,
           operation_id,
           dependency_key,
           base_revision,
           occurred_at,
           last_error,
           rowid AS queue_order,
           0 AS has_conflict
         FROM outbox_operations
         WHERE dependency_key = ?
           AND aggregate = 'transaction'
           AND state = 'rejected'
           AND last_error IS NOT NULL
         ORDER BY rowid ASC`,
        transactionId,
      );
      const operations = rows.filter(
        (operation) =>
          operation.aggregate === "transaction" &&
          operation.dependency_key === transactionId,
      );
      if (operations.length === 0) operations.push(selected);

      if (operations.some((operation) => operation.action === "create")) {
        if (await hasProtectedTransactionEvidence(sqlite, transactionId)) {
          throw new Error(
            "Transaksi sudah memiliki bukti pembayaran berhasil atau pencetakan dan tidak boleh diarsipkan otomatis. Rekonsiliasi dengan server diperlukan.",
          );
        }
        await sqlite.runAsync(
          `UPDATE transactions
           SET deleted_at = COALESCE(deleted_at, ?),
               payment_status = 'pending',
               payment_confirmed_revision = NULL,
               sync_state = 'error'
           WHERE id = ?`,
          new Date().toISOString(),
          transactionId,
        );
      } else {
        let recovered = false;
        let restoredRevision: number | null = null;
        const authoritativePaymentConflict = operations.find((operation) =>
          operation.last_error?.startsWith(PAYMENT_CONFLICT_ERROR_PREFIX),
        );
        if (authoritativePaymentConflict) {
          const audit = await sqlite.getFirstAsync<{
            payload_json: string;
          }>(
            `SELECT payload_json
             FROM audit_events
             WHERE aggregate_id = ?
               AND kind = 'sync.payment_conflict_authoritative'
               AND json_extract(payload_json, '$.operationId') = ?
             ORDER BY rowid DESC
             LIMIT 1`,
            transactionId,
            authoritativePaymentConflict.operation_id,
          );
          const authoritative = {
            ...parseAuthoritativePaymentConflict(audit?.payload_json),
            syncState: "synced" as const,
          };
          const firstDiscardedRevision = firstCorrectionRevision(operations);
          if (firstDiscardedRevision !== null) {
            await deleteTransactionArtifactsFromRevision(
              sqlite,
              transactionId,
              firstDiscardedRevision,
            );
          }
          await replaceTransaction(sqlite, authoritative);
          restoredRevision = authoritative.revision;
          recovered = true;
        } else {
          for (const operation of [...operations].reverse()) {
            if (operation.action === "correct") {
              if (operation.base_revision === null) {
                throw new Error("Revisi dasar koreksi tidak tersedia.");
              }
              const revision = await sqlite.getFirstAsync<{
                before_json: string | null;
              }>(
                `SELECT before_json
                 FROM transaction_revisions
                 WHERE transaction_id = ? AND revision = ?`,
                transactionId,
                operation.base_revision + 1,
              );
              if (!revision?.before_json) {
                throw new Error("Snapshot sebelum koreksi tidak tersedia.");
              }
              const before = {
                ...parseStoredTransaction(revision.before_json),
                syncState: "synced" as const,
              };
              await replaceTransaction(sqlite, before);
              restoredRevision = before.revision;
              recovered = true;
            } else if (operation.action === "set_payment_status") {
              const audit = await sqlite.getFirstAsync<{
                payload_json: string;
              }>(
                `SELECT payload_json
                 FROM audit_events
                 WHERE aggregate_id = ?
                   AND kind = 'payment.status_changed'
                   AND occurred_at = ?
                 ORDER BY rowid DESC
                 LIMIT 1`,
                transactionId,
                operation.occurred_at,
              );
              const before = {
                ...parsePaymentAuditBefore(audit?.payload_json),
                syncState: "synced" as const,
              };
              await replaceTransaction(sqlite, before);
              restoredRevision = before.revision;
              recovered = true;
            }
          }
        }
        if (!recovered) {
          throw new Error("Snapshot pemulihan transaksi tidak tersedia.");
        }
        if (restoredRevision !== null) {
          await sqlite.runAsync(
            `DELETE FROM transaction_items
             WHERE transaction_id = ? AND revision > ?`,
            transactionId,
            restoredRevision,
          );
          await sqlite.runAsync(
            `DELETE FROM transaction_revisions
             WHERE transaction_id = ? AND revision > ?`,
            transactionId,
            restoredRevision,
          );
        }
      }

      await sqlite.runAsync(
        `UPDATE outbox_operations
         SET state = 'resolved', last_error = NULL, next_attempt_at = NULL
         WHERE dependency_key = ?
           AND state IN ('rejected', 'discarded')`,
        transactionId,
      );
      return;
    }

    await sqlite.runAsync(
      `UPDATE outbox_operations
       SET state = 'discarded', last_error = NULL, next_attempt_at = NULL
       WHERE operation_id = ?`,
      operationId,
    );
    if (selected.dependency_key) {
      await recomputeTransactionSyncState(sqlite, selected.dependency_key);
    }
  });
}

export async function hasTerminalTransactionBlock(
  transactionId: string,
  mode?: LocalScope,
): Promise<boolean> {
  const { sqlite } = await getDatabase(mode);
  const row = await sqlite.getFirstAsync<{ blocked: number }>(
    `SELECT EXISTS(
       SELECT 1
         FROM outbox_operations
       WHERE dependency_key = ?
         AND aggregate = 'transaction'
         AND (
           state = 'conflict'
           OR (
             state IN ('rejected', 'discarded')
             AND last_error IS NOT NULL
           )
         )
     ) AS blocked`,
    transactionId,
  );
  return row?.blocked === 1;
}

export async function listConflicts(
  scope?: LocalScope,
): Promise<SyncConflict[]> {
  const { sqlite } = await getDatabase(scope);
  const rows = await sqlite.getAllAsync<{
    id: string;
    transaction_id: string;
    local_json: string;
    server_json: string;
    created_at: string;
  }>(
    `SELECT * FROM sync_conflicts
     WHERE resolved_at IS NULL ORDER BY created_at DESC`,
  );
  return rows.map((row) => ({
    id: row.id,
    transactionId: row.transaction_id,
    localSnapshot: parseStoredTransaction(row.local_json),
    serverSnapshot: parseStoredTransaction(row.server_json),
    createdAt: row.created_at,
  }));
}

export async function getConflictForTransaction(
  transactionId: string,
  scope?: LocalScope,
): Promise<SyncConflict | null> {
  const conflicts = await listConflicts(scope);
  return (
    conflicts.find((conflict) => conflict.transactionId === transactionId) ??
    null
  );
}

export function resolveConflict(
  conflict: SyncConflict,
  resolution: "server" | "retry-local",
  session: Session,
): Promise<void> {
  return withLocalMutation(session, () =>
    resolveConflictLocal(conflict, resolution, session),
  );
}

async function resolveConflictLocal(
  conflict: SyncConflict,
  resolution: "server" | "retry-local",
  session: Session,
): Promise<void> {
  if (resolution === "retry-local") assertSandboxSessionCurrent(session);
  if (!canCorrectTransaction(session, conflict.serverSnapshot))
    throw new Error(CORRECTION_FORBIDDEN_MESSAGE);
  const { sqlite } = await getDatabase(session);
  await assertNoQuarantinedDependency(sqlite, conflict.transactionId);
  const source = await sqlite.getFirstAsync<{
    operation_id: string;
    operation_json: string;
  }>(
    `SELECT operation_id, operation_json
     FROM outbox_operations
     WHERE dependency_key = ?
       AND aggregate = 'transaction'
       AND state = 'conflict'
       AND quarantine_reason IS NULL
     ORDER BY rowid ASC
     LIMIT 1`,
    conflict.transactionId,
  );
  if (!source) throw new Error("Operasi konflik tidak ditemukan.");

  let replacement:
    | {
        operation: Record<string, unknown> & { operationId: string };
        signature: string;
      }
    | undefined;
  let originalOperation:
    ReturnType<typeof parseCorrectionOutboxOperation> | undefined;
  if (resolution === "retry-local") {
    if (conflict.serverSnapshot.deletedAt) {
      throw new Error(
        "Versi server sudah dihapus dan tidak dapat ditimpa dengan versi lokal.",
      );
    }
    originalOperation = parseCorrectionOutboxOperation(source.operation_json);
    const terminal = await getOrCreateTerminalIdentity(
      session.tenantId ?? undefined,
    );
    if (!terminal.serverTerminalId)
      throw new Error("Daftarkan terminal sebelum mencoba ulang koreksi.");
    const operation = {
      ...originalOperation.raw,
      operationId: Crypto.randomUUID(),
      originSessionId: session.sessionId,
      originActorId: session.user.id,
      terminalId: terminal.serverTerminalId,
      baseRevision: conflict.serverSnapshot.revision,
      occurredAt: new Date().toISOString(),
    };
    replacement = {
      operation: operation as Record<string, unknown> & {
        operationId: string;
      },
      signature: await signCanonicalPayload(
        operation,
        session.tenantId ?? undefined,
      ),
    };
  }
  await sqlite.withTransactionAsync(async () => {
    const activeOperation = await sqlite.getFirstAsync<{
      operation_json: string;
    }>(
      `SELECT operation_json
       FROM outbox_operations
       WHERE operation_id = ? AND state = 'conflict'`,
      source.operation_id,
    );
    const activeConflict = await sqlite.getFirstAsync<{
      id: string;
      local_json: string;
      server_json: string;
    }>(
      `SELECT id, local_json, server_json
       FROM sync_conflicts
       WHERE id = ? AND transaction_id = ? AND resolved_at IS NULL`,
      conflict.id,
      conflict.transactionId,
    );
    if (
      !activeOperation ||
      activeOperation.operation_json !== source.operation_json ||
      !activeConflict ||
      !storedTransactionMatches(
        activeConflict.local_json,
        conflict.localSnapshot,
      ) ||
      !storedTransactionMatches(
        activeConflict.server_json,
        conflict.serverSnapshot,
      )
    ) {
      throw new Error(
        "Konflik berubah saat diproses. Muat ulang Pusat Sinkron.",
      );
    }

    await deleteTransactionArtifactsFromRevision(
      sqlite,
      conflict.transactionId,
      conflict.localSnapshot.revision,
    );

    if (resolution === "server") {
      await replaceTransaction(sqlite, {
        ...conflict.serverSnapshot,
        syncState: "synced",
      });
    } else {
      if (!replacement) throw new Error("Operasi pengganti tidak tersedia.");
      if (!originalOperation) {
        throw new Error("Operasi koreksi lokal tidak tersedia.");
      }
      const serverSnapshot: Transaction = {
        ...conflict.serverSnapshot,
        syncState: "synced",
      };
      const rebased: Transaction = {
        ...conflict.localSnapshot,
        // A retry is a new, explicitly attributed correction. Its amount must
        // follow the replacement origin session, not the old optimistic row.
        paymentAmount: resolvePaymentAmount(
          session.dataMode,
          conflict.localSnapshot.paymentMethod,
          conflict.localSnapshot.total,
          session.sandboxQrisPolicy,
        ),
        receiptIdentity: conflict.serverSnapshot.receiptIdentity,
        updatedActorName: session.user.fullName,
        revision: conflict.serverSnapshot.revision + 1,
        syncState: "pending",
        paymentStatus: "pending",
        paymentConfirmedRevision: null,
      };
      await replaceTransaction(sqlite, rebased);
      await sqlite.runAsync(
        `INSERT INTO transaction_revisions(
           transaction_id, revision, reason, before_json, after_json,
           origin_actor_id, submitting_actor_id, submitting_actor_name,
           terminal_id, client_occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        rebased.id,
        rebased.revision,
        originalOperation.reason,
        JSON.stringify(serverSnapshot),
        JSON.stringify(rebased),
        rebased.originActorId,
        session.user.id,
        rebased.updatedActorName,
        String(replacement.operation.terminalId),
        String(replacement.operation.occurredAt),
      );
      await insertOutbox(
        sqlite,
        replacement.operation,
        replacement.signature,
        conflict.transactionId,
      );
    }
    await sqlite.runAsync(
      `UPDATE outbox_operations
       SET state = 'resolved', last_error = NULL, next_attempt_at = NULL
       WHERE operation_id = ? AND state = 'conflict'`,
      source.operation_id,
    );
    await sqlite.runAsync(
      `UPDATE outbox_operations
       SET state = 'resolved', last_error = NULL, next_attempt_at = NULL
       WHERE dependency_key = ?
         AND state = 'rejected'`,
      conflict.transactionId,
    );
    await sqlite.runAsync(
      `UPDATE sync_conflicts
       SET resolved_at = ?, resolution = ?
       WHERE id = ? AND resolved_at IS NULL`,
      new Date().toISOString(),
      resolution,
      conflict.id,
    );
  });
}

export async function getSyncMetadata(mode?: LocalScope): Promise<{
  cursor: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
}> {
  const { sqlite } = await getDatabase(mode);
  const row = await sqlite.getFirstAsync<{
    cursor: string | null;
    last_synced_at: string | null;
    last_error: string | null;
  }>(
    "SELECT cursor, last_synced_at, last_error FROM sync_metadata WHERE singleton = 1",
  );
  return {
    cursor: row?.cursor ?? null,
    lastSyncedAt: row?.last_synced_at ?? null,
    lastError: row?.last_error ?? null,
  };
}

export interface RemoteChange {
  cursor: string;
  aggregate: "user" | "package" | "transaction" | "print_attempt" | "terminal";
  action: "upsert" | "delete";
  aggregateId: string;
  payload: unknown;
  changedAt: string;
}

export async function applyRemoteChanges(
  changes: RemoteChange[],
  nextCursor: string,
  mode?: LocalScope,
): Promise<void> {
  const { sqlite } = await getDatabase(mode);
  await sqlite.withTransactionAsync(async () => {
    for (const change of changes) {
      if (change.aggregate === "package") {
        if (!change.payload) {
          await sqlite.runAsync(
            `UPDATE packages_local
             SET active = 0, deleted_at = COALESCE(deleted_at, ?)
             WHERE id = ?`,
            new Date().toISOString(),
            change.aggregateId,
          );
          continue;
        }
        const value = change.payload as RentalPackage;
        await upsertPackageWithDatabase(sqlite, {
          ...value,
          deletedAt:
            change.action === "delete"
              ? (value.deletedAt ?? new Date().toISOString())
              : value.deletedAt,
        });
      } else if (change.aggregate === "transaction") {
        // Preserve the original optimistic record, revisions and signed queue
        // while any actor's evidence is quarantined. Explicit origin release
        // rewinds the pull cursor so these snapshots are fetched again safely.
        if (await hasQuarantinedDependency(sqlite, change.aggregateId))
          continue;
        const unresolvedConflict = await sqlite.getFirstAsync<{
          server_json: string;
        }>(
          `SELECT server_json
           FROM sync_conflicts
           WHERE transaction_id = ? AND resolved_at IS NULL
           ORDER BY created_at DESC
           LIMIT 1`,
          change.aggregateId,
        );
        if (unresolvedConflict) {
          const latestServerSnapshot: Transaction = change.payload
            ? {
                ...(change.payload as Transaction),
                syncState: "conflict",
              }
            : {
                ...parseStoredTransaction(unresolvedConflict.server_json),
                syncState: "conflict",
                deletedAt: change.changedAt,
              };
          await sqlite.runAsync(
            `UPDATE sync_conflicts
             SET server_json = ?
             WHERE transaction_id = ? AND resolved_at IS NULL`,
            JSON.stringify(latestServerSnapshot),
            change.aggregateId,
          );
        }
        const rejectedCorrection = await sqlite.getFirstAsync<{
          first_revision: number | null;
        }>(
          `SELECT MIN(base_revision + 1) AS first_revision
           FROM outbox_operations
           WHERE dependency_key = ?
             AND aggregate = 'transaction'
             AND action = 'correct'
             AND state IN ('rejected', 'discarded')
             AND last_error IS NOT NULL`,
          change.aggregateId,
        );
        if (rejectedCorrection?.first_revision != null) {
          await deleteTransactionArtifactsFromRevision(
            sqlite,
            change.aggregateId,
            rejectedCorrection.first_revision,
          );
        }
        if (!change.payload) {
          await sqlite.runAsync(
            `UPDATE transactions
             SET deleted_at = COALESCE(deleted_at, ?), sync_state = 'synced'
             WHERE id = ?`,
            change.changedAt,
            change.aggregateId,
          );
        } else {
          await replaceTransaction(sqlite, change.payload as Transaction);
        }
        await sqlite.runAsync(
          `UPDATE outbox_operations
           SET state = 'resolved', last_error = NULL, next_attempt_at = NULL
           WHERE dependency_key = ?
             AND state IN ('rejected', 'discarded')`,
          change.aggregateId,
        );
        await recomputeTransactionSyncState(sqlite, change.aggregateId);
      } else {
        await sqlite.runAsync(
          `INSERT INTO synced_entities(
             aggregate, aggregate_id, payload_json, deleted_at, changed_at
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(aggregate, aggregate_id) DO UPDATE SET
             payload_json = excluded.payload_json,
             deleted_at = excluded.deleted_at,
             changed_at = excluded.changed_at`,
          change.aggregate,
          change.aggregateId,
          change.payload === null ? null : JSON.stringify(change.payload),
          change.action === "delete" ? change.changedAt : null,
          change.changedAt,
        );
        if (
          change.aggregate === "print_attempt" &&
          change.action === "upsert" &&
          change.payload &&
          typeof change.payload === "object"
        ) {
          const attempt = change.payload as {
            transactionId?: unknown;
            status?: unknown;
          };
          if (
            typeof attempt.transactionId === "string" &&
            (attempt.status === "success" ||
              attempt.status === "failed" ||
              attempt.status === "unknown" ||
              attempt.status === "pending")
          ) {
            if (await hasQuarantinedDependency(sqlite, attempt.transactionId))
              continue;
            await sqlite.runAsync(
              "UPDATE transactions SET print_state = ? WHERE id = ?",
              attempt.status,
              attempt.transactionId,
            );
          }
        }
      }
    }
    await sqlite.runAsync(
      `UPDATE sync_metadata SET
         cursor = ?, status = 'idle', last_synced_at = ?, last_error = NULL
       WHERE singleton = 1`,
      nextCursor,
      new Date().toISOString(),
    );
  });
}

export async function setSyncError(
  message: string,
  mode?: LocalScope,
): Promise<void> {
  const { sqlite } = await getDatabase(mode);
  await sqlite.runAsync(
    "UPDATE sync_metadata SET status = 'error', last_error = ? WHERE singleton = 1",
    message,
  );
}

async function insertTransaction(
  database: SQLiteDatabase,
  transaction: Transaction,
): Promise<void> {
  await database.runAsync(
    `INSERT INTO transactions(
      id, revision, occurred_at, subtotal, total, payment_amount, origin_actor_id,
      origin_actor_name, updated_actor_name, terminal_id, sync_state,
      print_state, payment_method, payment_status,
      payment_confirmed_revision, qris_payload_hash, deleted_at, receipt_identity_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    transaction.id,
    transaction.revision,
    transaction.occurredAt,
    transaction.subtotal,
    transaction.total,
    transaction.paymentAmount,
    transaction.originActorId,
    transaction.originActorName,
    transaction.updatedActorName,
    transaction.terminalId,
    transaction.syncState,
    transaction.printState,
    transaction.paymentMethod,
    transaction.paymentStatus,
    transaction.paymentConfirmedRevision,
    transaction.qrisPayloadHash,
    transaction.deletedAt,
    transaction.receiptIdentity
      ? JSON.stringify(transaction.receiptIdentity)
      : null,
  );
  await insertItems(database, transaction);
}

async function insertItems(
  database: SQLiteDatabase,
  transaction: Transaction,
): Promise<void> {
  for (const item of transaction.items) {
    await database.runAsync(
      `INSERT OR IGNORE INTO transaction_items(
        id, transaction_id, revision, package_id, package_revision,
        name, description, accent, unit_price, quantity, line_total
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      item.id,
      transaction.id,
      transaction.revision,
      item.packageId,
      item.packageRevision,
      item.name,
      item.description,
      item.accent,
      item.unitPrice,
      item.quantity,
      item.lineTotal,
    );
  }
}

async function insertRevision(
  database: SQLiteDatabase,
  transaction: Transaction,
  reason: string | null,
  before: Transaction | null,
  session: Session,
): Promise<void> {
  await database.runAsync(
    `INSERT INTO transaction_revisions(
      transaction_id, revision, reason, before_json, after_json,
      origin_actor_id, submitting_actor_id, submitting_actor_name,
      terminal_id, client_occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    transaction.id,
    transaction.revision,
    reason,
    before ? JSON.stringify(before) : null,
    JSON.stringify(transaction),
    session.user.id,
    session.user.id,
    session.user.fullName,
    transaction.terminalId,
    new Date().toISOString(),
  );
}

async function insertOutbox(
  database: SQLiteDatabase,
  operation: Record<string, unknown> & { operationId: string },
  signature: string,
  dependencyKey: string,
): Promise<void> {
  await database.runAsync(
    `INSERT INTO outbox_operations(
      operation_id, aggregate, aggregate_id, action, base_revision,
      operation_json, signature, dependency_key, state, attempts, occurred_at,
      quarantine_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, COALESCE(
      (SELECT blocked_reason FROM scope_access WHERE singleton = 1),
      (SELECT quarantine_reason FROM outbox_operations WHERE dependency_key = ? AND quarantine_reason IS NOT NULL LIMIT 1)
    ))`,
    operation.operationId,
    String(operation.aggregate),
    String(operation.aggregateId),
    String(operation.action),
    typeof operation.baseRevision === "number" ? operation.baseRevision : null,
    JSON.stringify(operation),
    signature,
    dependencyKey,
    String(operation.occurredAt),
    dependencyKey,
  );
}

async function hydrateTransaction(
  database: SQLiteDatabase,
  row: TransactionRow,
): Promise<Transaction> {
  const items = await database.getAllAsync<TransactionItemRow>(
    `SELECT id, package_id, package_revision, name, description, accent,
            unit_price, quantity, line_total
     FROM transaction_items
     WHERE transaction_id = ? AND revision = ?
     ORDER BY id`,
    row.id,
    row.revision,
  );
  return {
    id: row.id,
    revision: row.revision,
    occurredAt: row.occurred_at,
    subtotal: row.subtotal,
    total: row.total,
    paymentAmount: row.payment_amount,
    originActorId: row.origin_actor_id,
    originActorName: row.origin_actor_name,
    updatedActorName: row.updated_actor_name,
    terminalId: row.terminal_id,
    syncState: row.sync_state,
    printState: row.print_state,
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    paymentConfirmedRevision: row.payment_confirmed_revision,
    qrisPayloadHash:
      row.payment_method === "qris"
        ? normalizeQrisPayloadHash(row.qris_payload_hash)
        : null,
    deletedAt: row.deleted_at,
    ...(row.receipt_identity_json
      ? {
          receiptIdentity: JSON.parse(
            row.receipt_identity_json,
          ) as Transaction["receiptIdentity"],
        }
      : {}),
    items: items.map(mapItem),
  };
}

async function replaceTransaction(
  database: SQLiteDatabase,
  transaction: Transaction,
): Promise<void> {
  const occurredAt = normalizeUtcTimestamp(transaction.occurredAt);
  await database.runAsync(
    `INSERT INTO transactions(
      id, revision, occurred_at, subtotal, total, payment_amount, origin_actor_id,
      origin_actor_name, updated_actor_name, terminal_id, sync_state,
      print_state, payment_method, payment_status,
      payment_confirmed_revision, qris_payload_hash, deleted_at, receipt_identity_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      revision = excluded.revision, occurred_at = excluded.occurred_at,
      subtotal = excluded.subtotal, total = excluded.total,
      payment_amount = excluded.payment_amount,
      origin_actor_id = excluded.origin_actor_id,
      origin_actor_name = excluded.origin_actor_name,
      updated_actor_name = excluded.updated_actor_name,
      terminal_id = excluded.terminal_id, sync_state = excluded.sync_state,
      print_state = excluded.print_state,
      payment_method = excluded.payment_method,
      payment_status = excluded.payment_status,
      payment_confirmed_revision = excluded.payment_confirmed_revision,
      qris_payload_hash = excluded.qris_payload_hash,
      deleted_at = excluded.deleted_at,
      receipt_identity_json = excluded.receipt_identity_json`,
    transaction.id,
    transaction.revision,
    occurredAt,
    transaction.subtotal,
    transaction.total,
    transaction.paymentAmount,
    transaction.originActorId,
    transaction.originActorName,
    transaction.updatedActorName,
    transaction.terminalId,
    transaction.syncState,
    transaction.printState,
    transaction.paymentMethod,
    transaction.paymentStatus,
    transaction.paymentConfirmedRevision,
    transaction.qrisPayloadHash,
    transaction.deletedAt,
    transaction.receiptIdentity
      ? JSON.stringify(transaction.receiptIdentity)
      : null,
  );
  await database.runAsync(
    `DELETE FROM transaction_items
     WHERE transaction_id = ? AND revision = ?`,
    transaction.id,
    transaction.revision,
  );
  await insertItems(database, transaction);
}

function mapPackage(row: PackageRow): RentalPackage {
  return {
    id: row.id,
    revision: row.revision,
    name: row.name,
    description: row.description,
    unitPrice: row.unit_price,
    accent: row.accent,
    active: row.active === 1,
    deletedAt: row.deleted_at,
  };
}

function mapItem(row: TransactionItemRow): TransactionItem {
  return {
    id: row.id,
    packageId: row.package_id,
    packageRevision: row.package_revision,
    name: row.name,
    description: row.description,
    accent: row.accent,
    unitPrice: row.unit_price,
    quantity: row.quantity,
    lineTotal: row.line_total,
  };
}

async function hasProtectedTransactionEvidence(
  database: SQLiteDatabase,
  transactionId: string,
): Promise<boolean> {
  const evidence = await database.getFirstAsync<{
    payment_status: PaymentStatus;
    has_print_attempt: number;
    has_success_audit: number;
  }>(
    `SELECT
       payment_status,
       EXISTS (
         SELECT 1
         FROM print_attempts
         WHERE print_attempts.transaction_id = transactions.id
       ) AS has_print_attempt,
       EXISTS (
         SELECT 1
         FROM audit_events
         WHERE audit_events.aggregate_id = transactions.id
           AND audit_events.kind = 'payment.status_changed'
           AND json_extract(audit_events.payload_json, '$.after.paymentStatus') = 'success'
           AND json_extract(audit_events.payload_json, '$.after.paymentConfirmedRevision')
               = json_extract(audit_events.payload_json, '$.after.revision')
       ) AS has_success_audit
     FROM transactions
     WHERE id = ?`,
    transactionId,
  );
  return (
    evidence?.payment_status === "success" ||
    evidence?.has_print_attempt === 1 ||
    evidence?.has_success_audit === 1
  );
}

async function shouldPreserveRejectedCreateEvidence(
  database: SQLiteDatabase,
  transactionId: string,
  operationId: string,
  action: string,
): Promise<boolean> {
  if (action === "create") {
    return hasProtectedTransactionEvidence(database, transactionId);
  }
  const predecessor = await database.getFirstAsync<{
    has_rejected_create: number;
  }>(
    `SELECT EXISTS (
       SELECT 1
       FROM outbox_operations rejected_create
       JOIN outbox_operations current_operation
         ON current_operation.operation_id = ?
       WHERE rejected_create.dependency_key = ?
         AND rejected_create.aggregate = 'transaction'
         AND rejected_create.action = 'create'
         AND rejected_create.state = 'rejected'
         AND rejected_create.rowid < current_operation.rowid
     ) AS has_rejected_create`,
    operationId,
    transactionId,
  );
  return (
    predecessor?.has_rejected_create === 1 &&
    (await hasProtectedTransactionEvidence(database, transactionId))
  );
}

function toMutationItems(items: TransactionItem[]) {
  return items.map((item) => ({
    packageId: item.packageId,
    packageRevision: item.packageRevision,
    quantity: item.quantity,
  }));
}

async function recomputeTransactionSyncState(
  database: SQLiteDatabase,
  transactionId: string,
): Promise<void> {
  await database.runAsync(
    `UPDATE transactions
     SET sync_state = CASE
       WHEN EXISTS (
         SELECT 1 FROM outbox_operations
         WHERE dependency_key = ? AND state = 'conflict'
       ) THEN 'conflict'
       WHEN EXISTS (
         SELECT 1 FROM outbox_operations
         WHERE dependency_key = ?
           AND state IN ('rejected', 'discarded')
           AND last_error IS NOT NULL
       ) THEN 'error'
       WHEN EXISTS (
         SELECT 1 FROM outbox_operations
         WHERE dependency_key = ? AND state = 'error'
       ) THEN 'error'
       WHEN EXISTS (
         SELECT 1 FROM outbox_operations
         WHERE dependency_key = ? AND state = 'pending'
       ) THEN 'pending'
       ELSE 'synced'
     END
     WHERE id = ?`,
    transactionId,
    transactionId,
    transactionId,
    transactionId,
    transactionId,
  );
}

async function deleteTransactionArtifactsFromRevision(
  database: SQLiteDatabase,
  transactionId: string,
  firstRevision: number,
): Promise<void> {
  await database.runAsync(
    `DELETE FROM transaction_items
     WHERE transaction_id = ? AND revision >= ?`,
    transactionId,
    firstRevision,
  );
  await database.runAsync(
    `DELETE FROM transaction_revisions
     WHERE transaction_id = ? AND revision >= ?`,
    transactionId,
    firstRevision,
  );
}

function firstCorrectionRevision(
  operations: { action: string; base_revision: number | null }[],
): number | null {
  const revisions = operations
    .filter(
      (operation): operation is { action: string; base_revision: number } =>
        operation.action === "correct" &&
        operation.base_revision !== null &&
        Number.isInteger(operation.base_revision),
    )
    .map((operation) => operation.base_revision + 1);
  return revisions.length > 0 ? Math.min(...revisions) : null;
}

function stripPaymentConflictPrefix(message: string): string {
  return message.startsWith(PAYMENT_CONFLICT_ERROR_PREFIX)
    ? message.slice(PAYMENT_CONFLICT_ERROR_PREFIX.length)
    : message;
}

function parseOutboxOperation(value: string | undefined): {
  raw: Record<string, unknown>;
  originActorId: string;
  originSessionId: string;
  terminalId: string;
} {
  if (!value) throw new Error("Operasi lokal tidak tersedia.");
  const raw = JSON.parse(value) as Record<string, unknown>;
  if (
    typeof raw.originActorId !== "string" ||
    typeof raw.originSessionId !== "string" ||
    typeof raw.terminalId !== "string"
  ) {
    throw new Error("Identitas operasi lokal tidak valid.");
  }
  return {
    raw,
    originActorId: raw.originActorId,
    originSessionId: raw.originSessionId,
    terminalId: raw.terminalId,
  };
}

function parseCorrectionOutboxOperation(
  value: string,
): ReturnType<typeof parseOutboxOperation> & { reason: string } {
  const operation = parseOutboxOperation(value);
  const payload =
    operation.raw.payload && typeof operation.raw.payload === "object"
      ? (operation.raw.payload as Record<string, unknown>)
      : null;
  if (
    operation.raw.action !== "correct" ||
    !payload ||
    typeof payload.reason !== "string"
  ) {
    throw new Error("Operasi koreksi lokal tidak valid.");
  }
  return { ...operation, reason: payload.reason };
}

function parseStoredTransaction(value: string): Transaction {
  const transaction = JSON.parse(value) as Transaction & {
    paymentAmount?: number;
    paymentMethod?: PaymentMethod;
    paymentStatus?: PaymentStatus;
    paymentConfirmedRevision?: number | null;
    qrisPayloadHash?: QrisPayloadHash | null;
  };
  const paymentMethod = transaction.paymentMethod ?? "legacy";
  return {
    ...transaction,
    paymentAmount: transaction.paymentAmount ?? transaction.total,
    paymentMethod,
    paymentStatus: transaction.paymentStatus ?? "success",
    paymentConfirmedRevision:
      transaction.paymentConfirmedRevision === undefined
        ? transaction.revision
        : transaction.paymentConfirmedRevision,
    qrisPayloadHash:
      paymentMethod === "qris"
        ? normalizeQrisPayloadHash(transaction.qrisPayloadHash)
        : null,
  };
}

function storedTransactionMatches(
  stored: string,
  expected: Transaction,
): boolean {
  try {
    return (
      canonicalize(parseStoredTransaction(stored)) === canonicalize(expected)
    );
  } catch {
    return false;
  }
}

function parsePaymentAuditBefore(value: string | undefined): Transaction {
  if (!value) {
    throw new Error("Riwayat pembayaran sebelum operasi tidak tersedia.");
  }
  const payload = JSON.parse(value) as { before?: unknown };
  if (!payload.before || typeof payload.before !== "object") {
    throw new Error("Snapshot pembayaran sebelum operasi tidak tersedia.");
  }
  const transaction = parseStoredTransaction(JSON.stringify(payload.before));
  if (
    typeof transaction.id !== "string" ||
    !Number.isInteger(transaction.revision) ||
    transaction.revision < 1 ||
    !Array.isArray(transaction.items)
  ) {
    throw new Error("Snapshot pembayaran sebelum operasi tidak valid.");
  }
  return transaction;
}

function parseAuthoritativePaymentConflict(
  value: string | undefined,
): Transaction {
  if (!value) {
    throw new Error("Snapshot pembayaran server tidak tersedia.");
  }
  const payload = JSON.parse(value) as { authoritative?: unknown };
  if (!payload.authoritative || typeof payload.authoritative !== "object") {
    throw new Error("Snapshot pembayaran server tidak valid.");
  }
  const transaction = parseStoredTransaction(
    JSON.stringify(payload.authoritative),
  );
  if (
    typeof transaction.id !== "string" ||
    !Number.isInteger(transaction.revision) ||
    transaction.revision < 1 ||
    !Array.isArray(transaction.items)
  ) {
    throw new Error("Snapshot pembayaran server tidak valid.");
  }
  return transaction;
}
