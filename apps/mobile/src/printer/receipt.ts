import { displayTransactionId } from "@/utils/format";
import { paymentMethodLabel } from "@/domain/payments";

import type { QrisPrintDocument, ReceiptDocument } from "./types";

function rupiah(value: number): string {
  return `Rp ${Math.trunc(value).toLocaleString("id-ID")}`;
}

function sanitize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, "?");
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

function wrapPrinterLine(value: string, columns: number): string[] {
  const clean = sanitize(value);
  if (!clean) return [];
  const words = clean.split(/\s+/).filter(Boolean);
  if (!words.length) return [clean.slice(0, columns)];
  const lines: string[] = [];
  let current = "";
  const flush = () => {
    if (current) {
      lines.push(current);
      current = "";
    }
  };
  const hardSplit = (token: string) => {
    for (let offset = 0; offset < token.length; offset += columns) {
      const chunk = token.slice(offset, offset + columns);
      if (chunk.length === columns) lines.push(chunk);
      else current = chunk;
    }
  };
  for (const word of words) {
    if (word.length > columns) {
      flush();
      hardSplit(word);
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (next.length <= columns) {
      current = next;
    } else {
      flush();
      current = word;
    }
  }
  flush();
  return lines;
}

function center(value: string, columns: number): string {
  const clean = sanitize(value).slice(0, columns);
  const left = Math.max(0, Math.floor((columns - clean.length) / 2));
  return `${" ".repeat(left)}${clean}`;
}

function centerLines(value: string, columns: number): string[] {
  return wrapPrinterLine(value, columns).map((line) => {
    const left = Math.max(0, Math.floor((columns - line.length) / 2));
    return `${" ".repeat(left)}${line}`;
  });
}

function fitReceiptLines(lines: string[], columns: number): string[] {
  return lines.flatMap((line) => {
    if (line.length <= columns) return [line];
    const chunks: string[] = [];
    for (let offset = 0; offset < line.length; offset += columns) {
      chunks.push(line.slice(offset, offset + columns));
    }
    return chunks;
  });
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
    ...centerLines(
      document.receiptIdentity?.businessName ?? "TELOMOYO POS",
      columns,
    ),
    ...(document.receiptIdentity?.address
      ? centerLines(document.receiptIdentity.address, columns)
      : []),
    ...(document.receiptIdentity?.phone
      ? centerLines(document.receiptIdentity.phone, columns)
      : []),
    document.isCopy ? center("*** SALINAN ***", columns) : "",
    rule,
    ...wrapPrinterLine(displayId, columns),
    ...wrapPrinterLine(`Revisi ${document.revision}`, columns),
    ...wrapPrinterLine(new Date(document.occurredAt).toISOString(), columns),
    ...wrapPrinterLine(`Kasir: ${document.cashierName}`, columns),
    ...wrapPrinterLine(
      `Metode: ${paymentMethodLabel[document.paymentMethod].toUpperCase()}`,
      columns,
    ),
    ...wrapPrinterLine("Status: LUNAS", columns),
    rule,
  ].filter((line) => line !== "");

  for (const line of document.lines) {
    output.push(...wrapPrinterLine(line.name, columns));
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
  return `${fitReceiptLines(output, columns).join("\n")}\n`;
}

export function encodeEscPos(
  document: ReceiptDocument,
  columns: 32 | 48,
): Uint8Array {
  const initialize = Uint8Array.from([0x1b, 0x40]);
  const fontA = Uint8Array.from([0x1b, 0x4d, 0x00]);
  const centerAlign = Uint8Array.from([0x1b, 0x61, 0x01]);
  const leftAlign = Uint8Array.from([0x1b, 0x61, 0x00]);
  const boldOn = Uint8Array.from([0x1b, 0x45, 0x01]);
  const boldOff = Uint8Array.from([0x1b, 0x45, 0x00]);
  const cut = Uint8Array.from([0x1d, 0x56, 0x41, 0x00]);
  // Bold everything: single ESC E on/off pair around the whole job. No font
  // size/width change, so the text layout is identical — only darker.
  // Starting each job with ESC @ clears emphasis/alignment left by an
  // interrupted earlier print. Font A is selected so 32/48 columns match
  // 58/80 mm. The native Bluetooth writer sends this in paced chunks with a
  // settle delay, so the full-bold job (slower, hotter head) is not truncated
  // by buffer overrun or early disconnect.
  const chunks: Uint8Array[] = [initialize, fontA, leftAlign, boldOn];
  for (const line of formatReceipt(document, columns).split("\n")) {
    const trimmed = line.trim();
    const warning =
      document.dataMode === "sandbox" &&
      (trimmed === "TEST - MODE UJI" || trimmed === "BUKAN STRUK RESMI");
    if (warning) {
      chunks.push(centerAlign, encodePrinterText(`${trimmed}\n`), leftAlign);
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

function formatQrisHeader(
  document: QrisPrintDocument,
  columns: 32 | 48,
): string {
  const rule = "-".repeat(columns);
  const lines = [
    ...(document.dataMode === "sandbox"
      ? [center("TEST - MODE UJI", columns)]
      : []),
    center("QRIS PEMBAYARAN", columns),
    centerLines(document.merchantName, columns).join("\n"),
    centerLines(document.merchantCity, columns).join("\n"),
    rule,
    ...wrapPrinterLine(
      displayTransactionId(document.transactionId, document.dataMode),
      columns,
    ),
    twoColumns("BAYAR", rupiah(document.paymentAmount), columns),
    ...(document.orderTotal !== document.paymentAmount
      ? [twoColumns("TOTAL PAKET", rupiah(document.orderTotal), columns)]
      : []),
    rule,
  ];
  return `${lines.join("\n")}\n`;
}

export function formatQrisSlip(
  document: QrisPrintDocument,
  columns: 32 | 48,
): string {
  return `${formatQrisHeader(document, columns)}[QRIS]\n${qrisFooter(document, columns)}`;
}

function qrisFooter(document: QrisPrintDocument, columns: 32 | 48): string {
  return `${[
    center("PINDAI QRIS UNTUK MEMBAYAR", columns),
    ...(document.dataMode === "sandbox"
      ? [center("BUKAN STRUK RESMI", columns)]
      : []),
    "",
    "",
    "",
  ].join("\n")}\n`;
}

export function encodeEscPosQris(
  document: QrisPrintDocument,
  columns: 32 | 48,
): Uint8Array {
  const data = encodePrinterText(document.payload);
  if (data.length < 1 || data.length > 2048) {
    throw new Error("Panjang payload QRIS tidak valid untuk printer.");
  }
  const storedLength = data.length + 3;
  const chunks = [
    Uint8Array.from([0x1b, 0x40, 0x1b, 0x4d, 0x00, 0x1b, 0x45, 0x01]),
    encodePrinterText(formatQrisHeader(document, columns)),
    Uint8Array.from([0x1b, 0x45, 0x00, 0x1b, 0x61, 0x01]),
    // ESC/POS QR model 2, 5-dot modules, medium error correction.
    Uint8Array.from([0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]),
    Uint8Array.from([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x05]),
    Uint8Array.from([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31]),
    Uint8Array.from([
      0x1d,
      0x28,
      0x6b,
      storedLength & 0xff,
      storedLength >> 8,
      0x31,
      0x50,
      0x30,
    ]),
    data,
    Uint8Array.from([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]),
    Uint8Array.from([0x0a, 0x1b, 0x61, 0x00]),
    encodePrinterText(qrisFooter(document, columns)),
    Uint8Array.from([0x1d, 0x56, 0x41, 0x00]),
  ];
  const result = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
