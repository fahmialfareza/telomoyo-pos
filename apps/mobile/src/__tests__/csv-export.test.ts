import { canExportReports } from "@/domain/permissions";
import type { Session } from "@/domain/types";
import { buildTransactionsCsv } from "@/reports/transactions-csv";
import { toCsv } from "@/utils/csv";

jest.mock("expo-file-system", () => ({ File: jest.fn(), Paths: {} }));
jest.mock("expo-sharing", () => ({ shareAsync: jest.fn() }));
jest.mock("@/db/repositories", () => ({
  listTransactionsForExport: jest.fn(),
}));

describe("toCsv", () => {
  it("quotes RFC 4180 specials, uses CRLF and starts with a UTF-8 BOM", () => {
    const csv = toCsv([
      ["Nama", "Catatan"],
      ['Paket "Sunrise"', "a,b"],
      ["Baris\nbaru", 120_000],
    ]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.slice(1)).toBe(
      'Nama,Catatan\r\n"Paket ""Sunrise""","a,b"\r\n"Baris\nbaru",120000\r\n',
    );
  });

  it("neutralises cells that spreadsheets would run as formulas", () => {
    const csv = toCsv([["=HYPERLINK(1)", "+62812", "-5", "@SUM(A1)", "Aman"]]);
    expect(csv.slice(1)).toBe("'=HYPERLINK(1),'+62812,'-5,'@SUM(A1),Aman\r\n");
  });
});

describe("buildTransactionsCsv", () => {
  it("writes one row per package with labels and the sandbox id prefix", () => {
    const csv = buildTransactionsCsv(
      [
        {
          transactionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          occurredAt: "2026-10-25T03:04:05.000Z",
          cashierName: "Putu",
          paymentMethod: "cash",
          syncState: "pending",
          transactionTotal: 140_000,
          paymentAmount: 140_000,
          itemName: "Paket Standar",
          quantity: 7,
          unitPrice: 20_000,
          lineTotal: 140_000,
        },
      ],
      "sandbox",
    );
    const [header, row] = csv.slice(1).trimEnd().split("\r\n");
    expect(header).toContain("ID transaksi,Waktu (WIB),Kasir,Metode,Paket");
    expect(row).toContain("TEST-");
    expect(row).toContain(
      ",Putu,Tunai,Paket Standar,7,20000,140000,140000,140000,Belum sinkron",
    );
  });
});

describe("canExportReports", () => {
  it("allows superadmins only", () => {
    expect(canExportReports({ user: { role: "superadmin" } } as Session)).toBe(
      true,
    );
    expect(canExportReports({ user: { role: "admin" } } as Session)).toBe(
      false,
    );
    expect(canExportReports(null)).toBe(false);
  });
});
