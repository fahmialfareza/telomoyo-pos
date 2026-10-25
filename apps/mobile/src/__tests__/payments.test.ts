import {
  cashChange,
  isPaymentConfirmedForCurrentRevision,
  paymentMethodLabel,
  resolvePaymentAmount,
  SANDBOX_QRIS_PAYMENT_AMOUNT,
  suggestCashAmounts,
} from "@/domain/payments";

describe("payment domain", () => {
  it("only confirms payment for the exact current transaction revision", () => {
    expect(
      isPaymentConfirmedForCurrentRevision({
        revision: 3,
        paymentStatus: "success",
        paymentConfirmedRevision: 3,
      }),
    ).toBe(true);
    expect(
      isPaymentConfirmedForCurrentRevision({
        revision: 3,
        paymentStatus: "success",
        paymentConfirmedRevision: 2,
      }),
    ).toBe(false);
  });

  it("labels legacy methods without pretending they were cash or QRIS", () => {
    expect(paymentMethodLabel.legacy).toBe("Metode lama");
  });

  it("preserves legacy fixed1000 interpretation without changing production payments", () => {
    expect(resolvePaymentAmount("sandbox", "qris", 245_000)).toBe(
      SANDBOX_QRIS_PAYMENT_AMOUNT,
    );
    expect(resolvePaymentAmount("sandbox", "cash", 245_000)).toBe(245_000);
    expect(resolvePaymentAmount("production", "qris", 245_000)).toBe(245_000);
  });

  it.each([1_000, 75_000, 249_500])(
    "uses the full transaction total %i for protocol3 Sandbox policy",
    (total) => {
      expect(
        resolvePaymentAmount("sandbox", "qris", total, "transaction_total"),
      ).toBe(total);
      expect(
        resolvePaymentAmount("sandbox", "cash", total, "transaction_total"),
      ).toBe(total);
      expect(
        resolvePaymentAmount("production", "qris", total, "fixed_1000"),
      ).toBe(total);
    },
  );
});

describe("cash change", () => {
  it("suggests the exact total, then larger amounts at note steps", () => {
    expect(suggestCashAmounts(140_000)).toEqual([140_000, 150_000, 200_000]);
    expect(suggestCashAmounts(100_000)).toEqual([
      100_000, 110_000, 150_000, 200_000,
    ]);
    expect(suggestCashAmounts(20_000)).toEqual([
      20_000, 30_000, 50_000, 100_000,
    ]);
    expect(suggestCashAmounts(0)).toEqual([]);
  });

  it("computes change only when the cash covers the total", () => {
    expect(cashChange(140_000, 150_000)).toBe(10_000);
    expect(cashChange(140_000, 140_000)).toBe(0);
    expect(cashChange(140_000, 100_000)).toBeNull();
  });
});
