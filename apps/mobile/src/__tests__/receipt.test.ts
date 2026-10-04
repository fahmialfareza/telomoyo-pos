import {
  encodeEscPos,
  encodeEscPosQris,
  formatQrisSlip,
  formatReceipt,
} from "@/printer/receipt";
import type { QrisPrintDocument, ReceiptDocument } from "@/printer/types";
import QRCode from "qrcode";

const receipt: ReceiptDocument = {
  transactionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  revision: 2,
  occurredAt: "2026-07-24T03:04:05.000Z",
  cashierName: "Putu",
  paymentMethod: "qris",
  lines: [
    {
      name: "Paket Sunrise",
      unitPrice: 100_000,
      quantity: 2,
      lineTotal: 200_000,
    },
  ],
  subtotal: 200_000,
  total: 200_000,
  paymentAmount: 200_000,
  dataMode: "production",
  isCopy: false,
};

const qrisSlip: QrisPrintDocument = {
  transactionId: receipt.transactionId,
  paymentAmount: 70_000,
  orderTotal: 70_000,
  merchantName: "Telomoyo Merchant",
  merchantCity: "Magelang",
  payload: "00020101021253033605405700005802ID6304ABCD",
  dataMode: "production",
};

describe("QRIS payment slip", () => {
  it.each([32, 48] as const)(
    "rasterizes the exact dynamic payload within %s-column paper",
    (columns) => {
      const bytes = Array.from(encodeEscPosQris(qrisSlip, columns));
      const storedCommand = [0x1d, 0x76, 0x30, 0x00];
      const offset = bytes.findIndex((value, index) =>
        storedCommand.every(
          (commandByte, relative) => bytes[index + relative] === commandByte,
        ),
      );
      expect(offset).toBeGreaterThanOrEqual(0);
      const rowBytes =
        (bytes[offset + 4] ?? 0) + (bytes[offset + 5] ?? 0) * 256;
      const height = (bytes[offset + 6] ?? 0) + (bytes[offset + 7] ?? 0) * 256;
      expect(rowBytes * 8).toBeLessThanOrEqual(columns === 32 ? 384 : 576);
      expect(height).toBeGreaterThan(100);
      const raster = bytes.slice(offset + 8, offset + 8 + rowBytes * height);
      expect(raster).toHaveLength(rowBytes * height);
      expect(raster.some((pixel) => pixel !== 0)).toBe(true);
      // White quiet-zone rows separate the payment text from the QR symbol.
      expect(raster.slice(0, rowBytes * 8).every((pixel) => pixel === 0)).toBe(
        true,
      );
      const matrix = QRCode.create(qrisSlip.payload, {
        errorCorrectionLevel: "M",
      });
      const scale = height / (matrix.modules.size + 8);
      for (let row = 0; row < matrix.modules.size; row += 1) {
        for (let col = 0; col < matrix.modules.size; col += 1) {
          const x = (col + 4) * scale;
          const y = (row + 4) * scale;
          const printed =
            ((raster[y * rowBytes + (x >> 3)] ?? 0) & (0x80 >> (x & 7))) !== 0;
          expect(printed).toBe(matrix.modules.get(row, col) !== 0);
        }
      }
      expect(formatQrisSlip(qrisSlip, columns)).toContain("Rp 70.000");
      expect(formatQrisSlip(qrisSlip, columns)).not.toContain("LUNAS");
      expect(bytes.slice(-4)).toEqual([0x1d, 0x56, 0x41, 0x00]);
    },
  );

  it("watermarks Sandbox QRIS and distinguishes actual charge from order total", () => {
    const output = formatQrisSlip(
      { ...qrisSlip, dataMode: "sandbox", paymentAmount: 1_000 },
      32,
    );
    expect(output).toContain("TEST - MODE UJI");
    expect(output).toContain("BUKAN STRUK RESMI");
    expect(output).toContain("Rp 1.000");
    expect(output).toContain("Rp 70.000");
  });
});

describe("thermal receipt", () => {
  it("uses the snapshotted business identity for tenant reprints and keeps the app credit", () => {
    const snapshot = {
      businessName: "Penyewaan Merbabu",
      address: "Jl. Merbabu 12",
      phone: "08123456789",
      revision: 3,
    };
    const output = formatReceipt(
      { ...receipt, receiptIdentity: snapshot, isCopy: true },
      48,
    );
    expect(output).toContain(snapshot.businessName);
    expect(output).toContain(snapshot.address);
    expect(output).toContain(snapshot.phone);
    expect(output).toContain("Telomoyo POS");
    expect(output).toContain("SALINAN");
    expect(output).not.toContain("MODE UJI");
    const sandbox = formatReceipt(
      {
        ...receipt,
        receiptIdentity: snapshot,
        dataMode: "sandbox",
        paymentAmount: 1000,
      },
      48,
    );
    expect(sandbox).toContain(snapshot.businessName);
    expect(sandbox.match(/MODE UJI/g)).toHaveLength(1);
    expect(sandbox).toContain("Rp 1.000");
  });

  it("adds the display-only transaction prefix and respects paper width", () => {
    const output = formatReceipt(receipt, 32);
    expect(output).toContain("TRX-01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(output).toContain("TOTAL");
    expect(output).toContain("Metode: QRIS");
    expect(output).toContain("Status: LUNAS");
    expect(output).toContain("TELOMOYO POS");
    expect(output).not.toContain("SEWA MOTOR POS");
    expect(output).not.toContain("SEWA MOTOR\n");
    expect(output).not.toContain("SALINAN");
    for (const line of output.trimEnd().split("\n")) {
      expect(line.length).toBeLessThanOrEqual(32);
    }
  });

  it("marks explicit copies and wraps output in ESC/POS init and cut bytes", () => {
    const copy = { ...receipt, isCopy: true };
    expect(formatReceipt(copy, 48)).toContain("*** SALINAN ***");
    const bytes = encodeEscPos(copy, 48);
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x1b, 0x40]);
    expect(Array.from(bytes.slice(-4))).toEqual([0x1d, 0x56, 0x41, 0]);
  });

  it("permanently marks Sandbox output compactly and preserves legacy amounts", () => {
    const sandboxReceipt = {
      ...receipt,
      dataMode: "sandbox" as const,
      paymentAmount: 1_000,
    };
    const output = formatReceipt(sandboxReceipt, 48);

    expect(output).toContain("TEST-TRX-01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(output.match(/TEST - MODE UJI/g)).toHaveLength(1);
    expect(output.match(/BUKAN STRUK RESMI/g)).toHaveLength(1);
    expect(output).toContain("TOTAL");
    expect(output).not.toContain("TOTAL SIMULASI");
    expect(output).toContain("QRIS NYATA");
    expect(output).toContain("Rp 1.000");

    const bytes = Array.from(encodeEscPos(sandboxReceipt, 48));
    const doubleHeightCommand = [0x1d, 0x21, 0x10];
    expect(countByteSequence(bytes, doubleHeightCommand)).toBe(0);
    // Full-bold job: one ESC E on/off pair around everything.
    expect(countByteSequence(bytes, [0x1b, 0x45, 0x01])).toBe(1);
    expect(countByteSequence(bytes, [0x1b, 0x45, 0x00])).toBe(1);
  });

  it.each([
    ["production", 32],
    ["production", 48],
    ["sandbox", 32],
    ["sandbox", 48],
  ] as const)(
    "emphasizes every %s receipt line at %s columns and resets before cutting",
    (dataMode, columns) => {
      const document = { ...receipt, dataMode, isCopy: true };
      const bytes = Array.from(encodeEscPos(document, columns));
      expect(bytes.slice(0, 11)).toEqual([
        0x1b,
        0x40, // initialize: reset a prior interrupted job
        0x1b,
        0x4d,
        0x00, // Font A so 32/48 columns match 58/80 mm
        0x1b,
        0x61,
        0x00, // left alignment
        0x1b,
        0x45,
        0x01, // emphasis on before the first printed character
      ]);
      expect(bytes.slice(-10)).toEqual([
        0x1b,
        0x45,
        0x00, // emphasis off after all receipt content
        0x1b,
        0x61,
        0x00, // left alignment
        0x1d,
        0x56,
        0x41,
        0x00, // cut
      ]);
      expect(countByteSequence(bytes, [0x1b, 0x45, 0x01])).toBe(1);
      expect(countByteSequence(bytes, [0x1b, 0x45, 0x00])).toBe(1);

      // Apart from the existing Sandbox warning centering commands, the
      // emitted text is unchanged. No font size, width, or density changes.
      const text = String.fromCharCode(...bytes)
        .replace(/\x1b[@]/g, "")
        .replace(/\x1b\x4d[\x00\x01]/g, "")
        .replace(/\x1b[\x61\x45][\x00\x01]/g, "")
        .replace(/\x1d\x56\x41\x00/g, "");
      const expected = formatReceipt(document, columns)
        .split("\n")
        .map((line) =>
          dataMode === "sandbox" &&
          ["TEST - MODE UJI", "BUKAN STRUK RESMI"].includes(line.trim())
            ? line.trim()
            : line,
        )
        .join("\n");
      expect(text).toBe(`${expected}\n`);
    },
  );

  it.each([32, 48] as const)(
    "uses the full Sandbox total and fits %s columns without losing the TEST ID",
    (columns) => {
      const output = formatReceipt(
        { ...receipt, dataMode: "sandbox" },
        columns,
      );
      expect(output).toContain("TEST - MODE UJI");
      expect(output).toContain("BUKAN STRUK RESMI");
      expect(output).toContain("Rp 200.000");
      expect(output).not.toContain("QRIS NYATA");
      expect(output.replace(/\n/g, "")).toContain(
        "TEST-TRX-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      );
      for (const line of output.trimEnd().split("\n")) {
        expect(line.length).toBeLessThanOrEqual(columns);
      }
    },
  );

  it.each([32, 48] as const)(
    "word-wraps long cashier, identity, and item names within %s columns",
    (columns) => {
      const cashierName = Array.from(
        { length: 20 },
        (_, index) => `Nama${index + 1}`,
      ).join(" ");
      const businessName =
        "Penyewaan Motor Gunung Merbabu Jawa Tengah Indonesia";
      const address =
        "Jl. Merbabu Raya Nomor 12 Kelurahan Selo Kabupaten Boyolali";
      const itemName =
        "Paket Sunrise Plus Extra Helm dan Jas Hujan untuk dua orang";
      const output = formatReceipt(
        {
          ...receipt,
          cashierName,
          lines: [
            {
              name: itemName,
              unitPrice: 100_000,
              quantity: 2,
              lineTotal: 200_000,
            },
          ],
          receiptIdentity: {
            businessName,
            address,
            phone: "081234567890123456789",
            revision: 3,
          },
        },
        columns,
      );
      const printed = output.replace(/\n/g, " ").replace(/\s+/g, " ");
      expect(printed).toContain(cashierName);
      expect(printed).toContain(businessName);
      expect(printed).toContain(address);
      expect(printed).toContain(itemName);
      expect(output).not.toMatch(/Penyewaa\n\s*n/);
      expect(output).not.toMatch(/Wijay\n\s*a/);
      for (const line of output.trimEnd().split("\n")) {
        expect(line.length).toBeLessThanOrEqual(columns);
      }
    },
  );

  it("keeps the exact Production text layout unchanged", () => {
    expect(formatReceipt(receipt, 32)).toBe(
      [
        "          TELOMOYO POS",
        "--------------------------------",
        "TRX-01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "Revisi 2",
        "2026-07-24T03:04:05.000Z",
        "Kasir: Putu",
        "Metode: QRIS",
        "Status: LUNAS",
        "--------------------------------",
        "Paket Sunrise",
        "2 x Rp 100.000        Rp 200.000",
        "--------------------------------",
        "Subtotal              Rp 200.000",
        "TOTAL                 Rp 200.000",
        "--------------------------------",
        "          Terima kasih",
        "",
        "",
        "",
        "",
      ].join("\n"),
    );
  });
});

function countByteSequence(bytes: number[], sequence: number[]): number {
  let count = 0;
  for (let index = 0; index <= bytes.length - sequence.length; index += 1) {
    if (sequence.every((value, offset) => bytes[index + offset] === value)) {
      count += 1;
    }
  }
  return count;
}
