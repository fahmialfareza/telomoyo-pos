import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";

import {
  listTransactionsForExport,
  type ExportTransactionLine,
} from "@/db/repositories";
import { paymentMethodLabel } from "@/domain/payments";
import type { DataMode, LocalScope, SyncState } from "@/domain/types";
import { toCsv, type CsvCell } from "@/utils/csv";
import { displayTransactionId, formatJakartaDateTime } from "@/utils/format";
import type { ReportingRange } from "@/utils/time";

const syncStateLabel: Record<SyncState, string> = {
  pending: "Belum sinkron",
  synced: "Tersinkron",
  conflict: "Konflik",
  error: "Gagal sinkron",
};

export const TRANSACTION_CSV_HEADER = [
  "ID transaksi",
  "Waktu (WIB)",
  "Kasir",
  "Metode",
  "Paket",
  "Jumlah",
  "Harga satuan",
  "Subtotal paket",
  "Total transaksi",
  "Dibayar",
  "Status sinkron",
] as const;

export function buildTransactionsCsv(
  lines: readonly ExportTransactionLine[],
  dataMode: DataMode,
): string {
  const rows: CsvCell[][] = [
    [...TRANSACTION_CSV_HEADER],
    ...lines.map((line) => [
      displayTransactionId(line.transactionId, dataMode),
      formatJakartaDateTime(line.occurredAt),
      line.cashierName,
      paymentMethodLabel[line.paymentMethod],
      line.itemName,
      line.quantity,
      line.unitPrice,
      line.lineTotal,
      line.transactionTotal,
      line.paymentAmount,
      syncStateLabel[line.syncState],
    ]),
  ];
  return toCsv(rows);
}

/** Writes the period's paid sales to a cache file and opens the Android share
 * sheet (WhatsApp, Drive, email). Returns false when the period is empty. */
export async function shareTransactionsCsv({
  range,
  fileLabel,
  scope,
  dataMode,
}: {
  range: ReportingRange;
  fileLabel: string;
  scope: LocalScope;
  dataMode: DataMode;
}): Promise<boolean> {
  const lines = await listTransactionsForExport(range, scope);
  if (lines.length === 0) return false;
  const prefix = dataMode === "sandbox" ? "uji-" : "";
  const file = new File(Paths.cache, `${prefix}penjualan-${fileLabel}.csv`);
  file.create({ overwrite: true });
  await file.write(buildTransactionsCsv(lines, dataMode));
  await Sharing.shareAsync(file.uri, {
    mimeType: "text/csv",
    dialogTitle: "Bagikan laporan penjualan",
  });
  return true;
}
