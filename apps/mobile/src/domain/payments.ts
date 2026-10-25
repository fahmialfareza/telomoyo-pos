import type {
  DataMode,
  PaymentMethod,
  PaymentStatus,
  Transaction,
  SandboxQrisPolicy,
  Session,
} from "./types";

export const SANDBOX_QRIS_PAYMENT_AMOUNT = 1_000;

export function resolvePaymentAmount(
  dataMode: DataMode,
  method: PaymentMethod,
  total: number,
  policy: SandboxQrisPolicy = "fixed_1000",
): number {
  return dataMode === "sandbox" && method === "qris" && policy === "fixed_1000"
    ? SANDBOX_QRIS_PAYMENT_AMOUNT
    : total;
}

export const SANDBOX_SESSION_UPGRADE_MESSAGE =
  "Sesi Mode Uji perlu diperbarui agar QRIS menggunakan total transaksi. Hubungkan internet lalu pilih Perbarui sesi Mode Uji di Pengaturan. Data lama tetap tersimpan.";

export function assertSandboxSessionCurrent(session: Session): void {
  if (
    session.dataMode === "sandbox" &&
    ((session.protocolVersion ?? 2) < 3 ||
      session.sandboxQrisPolicy !== "transaction_total")
  ) {
    throw new Error(SANDBOX_SESSION_UPGRADE_MESSAGE);
  }
}

/** Quick amounts for the cash sheet: the exact total first, then the next
 * amounts above it at Rp10k/50k/100k steps that a customer is likely to hand
 * over. Rounding is strictly above the total, so round totals still get
 * larger-note suggestions. */
export function suggestCashAmounts(total: number, limit = 3): number[] {
  if (total <= 0) return [];
  const larger = [10_000, 50_000, 100_000].map(
    (step) => (Math.floor(total / step) + 1) * step,
  );
  return [total, ...[...new Set(larger)].sort((a, b) => a - b).slice(0, limit)];
}

export function cashChange(total: number, received: number): number | null {
  return received >= total ? received - total : null;
}

export const paymentMethodLabel: Record<PaymentMethod, string> = {
  cash: "Tunai",
  qris: "QRIS",
  legacy: "Metode lama",
};

export const paymentStatusLabel: Record<PaymentStatus, string> = {
  pending: "Menunggu pembayaran",
  success: "Lunas",
  failed: "Pembayaran gagal",
};

export function isPaymentConfirmedForCurrentRevision(
  transaction: Pick<
    Transaction,
    "paymentStatus" | "paymentConfirmedRevision" | "revision"
  >,
): boolean {
  return (
    transaction.paymentStatus === "success" &&
    transaction.paymentConfirmedRevision === transaction.revision
  );
}
