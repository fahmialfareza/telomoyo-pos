import { displayTransactionId } from "@/utils/format";
import { paymentMethodLabel } from "@/domain/payments";

import type { ReceiptDocument } from "./types";

function rupiah(value: number): string {
  return `Rp ${Math.trunc(value).toLocaleString("id-ID")}`;
}

function sanitize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, "?");
}

function center(value: string, columns: number): string {
  const clean = sanitize(value).slice(0, columns);
  const left = Math.max(0, Math.floor((columns - clean.length) / 2));
  return `${" ".repeat(left)}${clean}`;
}

function twoColumns(left: string, right: string, columns: number): string {
  const cleanLeft = sanitize(left);
  const cleanRight = sanitize(right);
  const maximumLeft = Math.max(1, columns - cleanRight.length - 1);
  const clippedLeft = cleanLeft.slice(0, maximumLeft);
  return `${clippedLeft}${" ".repeat(
    Math.max(1, columns - clippedLeft.length - cleanRight.length),
  )}${cleanRight.slice(0, columns - clippedLeft.length - 1)}`;
}

export function formatReceipt(
  document: ReceiptDocument,
  columns: 32 | 48,
): string {
  const rule = "-".repeat(columns);
  const sandbox = document.dataMode === "sandbox";
  const displayId = displayTransactionId(
    document.transactionId,
    document.dataMode,
  );
  const output = [
    // Thermal printers use an ASCII code page. The dash is intentionally
    // printable on every adapter instead of replacing an em dash with '?'.
    sandbox ? center("TEST - MODE UJI", columns) : "",
    sandbox ? rule : "",
    center(document.receiptIdentity?.businessName ?? "TELOMOYO POS", columns),
    document.receiptIdentity?.address
      ? center(document.receiptIdentity.address, columns)
      : "",
    document.receiptIdentity?.phone
      ? center(document.receiptIdentity.phone, columns)
      : "",
    document.isCopy ? center("*** SALINAN ***", columns) : "",
    rule,
    ...(sandbox ? wrapPrinterLine(displayId, columns) : [displayId]),
    `Revisi ${document.revision}`,
    new Date(document.occurredAt).toISOString(),
    `Kasir: ${sanitize(document.cashierName)}`,
    `Metode: ${paymentMethodLabel[document.paymentMethod].toUpperCase()}`,
    "Status: LUNAS",
    rule,
  ].filter(Boolean);

  for (const line of document.lines) {
    output.push(sanitize(line.name).slice(0, columns));
    output.push(
      twoColumns(
        `${line.quantity} x ${rupiah(line.unitPrice)}`,
        rupiah(line.lineTotal),
        columns,
      ),
    );
  }

  output.push(
    rule,
    twoColumns("Subtotal", rupiah(document.subtotal), columns),
    twoColumns("TOTAL", rupiah(document.total), columns),
    ...(sandbox &&
    document.paymentMethod === "qris" &&
    document.paymentAmount !== document.total
      ? [twoColumns("QRIS NYATA", rupiah(document.paymentAmount), columns)]
      : []),
    rule,
    ...(sandbox ? [center("BUKAN STRUK RESMI", columns), rule] : []),
    center("Terima kasih", columns),
    ...(document.receiptIdentity ? [center("Telomoyo POS", columns)] : []),
    "",
    "",
    "",
  );
  return `${output.join("\n")}\n`;
}

function wrapPrinterLine(value: string, columns: number): string[] {
  const clean = sanitize(value);
  const lines: string[] = [];
  for (let offset = 0; offset < clean.length; offset += columns) {
    lines.push(clean.slice(offset, offset + columns));
  }
  return lines;
}

export function encodeEscPos(
  document: ReceiptDocument,
  columns: 32 | 48,
): Uint8Array {
  const initialize = Uint8Array.from([0x1b, 0x40]);
  const centerAlign = Uint8Array.from([0x1b, 0x61, 0x01]);
  const leftAlign = Uint8Array.from([0x1b, 0x61, 0x00]);
  const boldOn = Uint8Array.from([0x1b, 0x45, 0x01]);
  const boldOff = Uint8Array.from([0x1b, 0x45, 0x00]);
  const cut = Uint8Array.from([0x1d, 0x56, 0x41, 0x00]);
  // Bold everything: single ESC E on/off pair around the whole job. No font
  // size/width change, so the text layout is identical — only darker.
  // Starting each job with ESC @ clears emphasis/alignment left by an
  // interrupted earlier print. The native Bluetooth writer sends this in
  // paced 64B chunks with a settle delay, so the full-bold job (slower,
  // hotter head) is not truncated by buffer overrun or early disconnect.
  const chunks: Uint8Array[] = [initialize, leftAlign, boldOn];
  for (const line of formatReceipt(document, columns).split("\n")) {
    const trimmed = line.trim();
    const warning =
      document.dataMode === "sandbox" &&
      (trimmed === "TEST - MODE UJI" || trimmed === "BUKAN STRUK RESMI");
    if (warning) {
      chunks.push(
        centerAlign,
        encodePrinterText(`${trimmed}\n`),
        leftAlign,
      );
      continue;
    }
    chunks.push(encodePrinterText(`${line}\n`));
  }
  // Leave the printer in its normal text state for the next job. Do not use
  // model-specific heat/density commands: their ranges vary by hardware.
  chunks.push(boldOff, leftAlign, cut);

  const result = new Uint8Array(
    chunks.reduce((length, chunk) => length + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function encodePrinterText(value: string): Uint8Array {
  return Uint8Array.from(
    Array.from(value, (character) => {
      const code = character.charCodeAt(0);
      return code >= 32 || code === 10 ? Math.min(code, 126) : 63;
    }),
  );
}
