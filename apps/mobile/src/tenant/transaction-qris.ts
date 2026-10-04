import type { Session, Transaction } from "@/domain/types";
import {
  createDynamicQris,
  fingerprintStaticQris,
  validateStaticQris,
} from "@/domain/qris";
import type { QrisPrintDocument } from "@/printer/types";
import { readQrisConfig } from "@/security/secure-store";

import { qrisPayloadForTransaction } from "./configuration";

export async function qrisDocumentForTransaction(
  transaction: Transaction,
  session: Session,
): Promise<QrisPrintDocument> {
  if (transaction.paymentMethod !== "qris") {
    throw new Error("Transaksi ini tidak menggunakan QRIS.");
  }
  if (!transaction.qrisPayloadHash) {
    throw new Error(
      "Sumber QRIS historis transaksi tidak tersedia. QRIS tidak akan ditampilkan menggunakan merchant lain.",
    );
  }
  let source = await qrisPayloadForTransaction(
    transaction.qrisPayloadHash,
    session,
  );
  if (!source) {
    const local = await readQrisConfig(session.tenantId ?? undefined);
    source = local?.staticPayload ?? null;
  }
  if (
    !source ||
    (await fingerprintStaticQris(source)) !== transaction.qrisPayloadHash
  ) {
    throw new Error(
      "Payload QRIS asli transaksi tidak tersedia atau tidak cocok. Pulihkan versi QRIS merchant yang benar.",
    );
  }
  const staticQris = validateStaticQris(source);
  const dynamic = createDynamicQris(
    staticQris.payload,
    transaction.paymentAmount,
  );
  return {
    transactionId: transaction.id,
    paymentAmount: transaction.paymentAmount,
    orderTotal: transaction.total,
    merchantName: dynamic.merchantName,
    merchantCity: dynamic.merchantCity,
    payload: dynamic.payload,
    dataMode: session.dataMode,
  };
}
