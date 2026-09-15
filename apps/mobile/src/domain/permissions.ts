import type { Session, Transaction } from "./types";

export const CORRECTION_FORBIDDEN_MESSAGE =
  "Admin hanya dapat mengoreksi transaksi miliknya sendiri.";
export const PAYMENT_FORBIDDEN_MESSAGE =
  "Admin hanya dapat memperbarui pembayaran transaksi miliknya sendiri.";

export function canCorrectTransaction(
  session: Session | null | undefined,
  transaction: Pick<Transaction, "originActorId"> | null | undefined,
): boolean {
  if (!session || !transaction) return false;

  return (
    session.user.role === "superadmin" ||
    session.user.id === transaction.originActorId
  );
}

export const canManageTransactionPayment = canCorrectTransaction;

/**
 * Organization-wide administration (Pengguna, Kelola tenant, audit) belongs to an
 * active Superadmin session. The account context and a selected-business context
 * both authorize it, so Pengguna opens inside the bottom tab without exchanging
 * context or opening a business database. The retired platform permission stays
 * rejected, matching the server contract.
 */
export function canManageOrganization(
  session: Session | null | undefined,
): session is Session {
  if (!session) return false;
  if (session.user.role !== "superadmin") return false;
  return session.contextKind !== "platform";
}
