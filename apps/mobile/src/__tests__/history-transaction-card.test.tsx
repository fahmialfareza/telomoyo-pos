import { fireEvent, render } from "@testing-library/react-native";

import { HistoryTransactionCard } from "@/components/history/HistoryTransactionCard";
import type { Transaction } from "@/domain/types";

jest.mock("@/components/ui/Icon", () => ({
  Icon: () => null,
}));

const transaction: Transaction = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  revision: 1,
  occurredAt: "2026-07-24T03:04:05.000Z",
  subtotal: 150_000,
  total: 150_000,
  paymentAmount: 150_000,
  originActorId: "actor-1",
  originActorName: "Penyok",
  updatedActorName: "Penyok",
  terminalId: "terminal-1",
  syncState: "synced",
  printState: "success",
  paymentMethod: "qris",
  paymentStatus: "success",
  paymentConfirmedRevision: 1,
  qrisPayloadHash:
    "9185bbfe94bb008d611da515fc94c2f3ad5f0c3fbfe278d8bdb463f9ce1cf500",
  deletedAt: null,
  items: [
    {
      id: "item-1",
      packageId: "package-1",
      packageRevision: 1,
      name: "Paket Standard",
      description: "Sewa motor harian",
      accent: "standard",
      unitPrice: 75_000,
      quantity: 2,
      lineTotal: 150_000,
    },
  ],
};

describe("HistoryTransactionCard", () => {
  it("shows a concise transaction summary and its statuses", () => {
    const screen = render(
      <HistoryTransactionCard onPress={jest.fn()} transaction={transaction} />,
    );

    expect(screen.getByText("Paket Standard")).toBeTruthy();
    expect(screen.getByText("Rp 150.000")).toBeTruthy();
    expect(screen.getByText("Penyok")).toBeTruthy();
    expect(screen.getByText("Tersinkron")).toBeTruthy();
    expect(screen.getByText("QRIS")).toBeTruthy();
    expect(screen.getByText("Lunas")).toBeTruthy();
  });

  it("opens the transaction from one accessible card action", () => {
    const onPress = jest.fn();
    const screen = render(
      <HistoryTransactionCard onPress={onPress} transaction={transaction} />,
    );

    const card = screen.getByRole("button", {
      name: /Buka transaksi TRX-.*Paket Standard.*QRIS.*Lunas.*tersinkron.*tercetak/i,
    });
    fireEvent.press(card);

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("marks Sandbox transaction IDs as test-only", () => {
    const screen = render(
      <HistoryTransactionCard
        dataMode="sandbox"
        onPress={jest.fn()}
        transaction={transaction}
      />,
    );

    expect(screen.getByText(/^TEST-TRX-/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Buka transaksi TEST-TRX-/i }),
    ).toBeTruthy();
  });
});
