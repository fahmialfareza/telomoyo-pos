import { fireEvent, render, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { Keyboard } from "react-native";

import HistoryScreen from "@/app/(app)/(tabs)/history";

const mockListTransactions = jest.fn();
const mockListHistoryPackageOptions = jest.fn();
const mockListHistoryCreatorOptions = jest.fn();
const mockRouterPush = jest.fn();
const mockSession = {
  tenantId: "00000000-0000-4000-8000-000000000200",
  user: { fullName: "Andi" },
};
jest.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({ session: mockSession }),
}));

jest.mock("expo-router", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    useRouter: () => ({ push: mockRouterPush }),
    useFocusEffect: (effect: () => void | (() => void)) =>
      React.useEffect(effect, [effect]),
  };
});

jest.mock("@/db/repositories", () => ({
  listTransactions: (filter: unknown, scope: unknown) => {
    expect(scope).toBe(mockSession);
    return mockListTransactions(filter);
  },
  listHistoryPackageOptions: () => mockListHistoryPackageOptions(),
  listHistoryCreatorOptions: () => mockListHistoryCreatorOptions(),
}));

jest.mock("@/components/reporting/DateMonthFilter", () => {
  const { Pressable, Text, View } =
    jest.requireActual<typeof import("react-native")>("react-native");

  return {
    DateMonthFilter: ({
      mode,
      date,
      month,
      onModeChange,
      onDateChange,
      onMonthChange,
    }: {
      mode: "date" | "month";
      date: string;
      month: string;
      onModeChange: (mode: "date" | "month") => void;
      onDateChange: (date: string) => void;
      onMonthChange: (month: string) => void;
    }) => (
      <View accessibilityLabel="Filter tanggal dan bulan">
        <Text>{mode === "date" ? "Tanggal" : "Bulan"}</Text>
        <Text>{date}</Text>
        <Text>{month}</Text>
        <Pressable
          accessibilityLabel="Pilih mode bulan"
          accessibilityRole="button"
          onPress={() => onModeChange("month")}
        >
          <Text>Mode bulan</Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Gunakan tanggal 25 Juli 2026"
          accessibilityRole="button"
          onPress={() => onDateChange("2026-07-25")}
        >
          <Text>Pilih tanggal tertentu</Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Gunakan bulan Juni 2026"
          accessibilityRole="button"
          onPress={() => onMonthChange("2026-06")}
        >
          <Text>Pilih bulan tertentu</Text>
        </Pressable>
      </View>
    ),
  };
});

jest.mock("@/components/layout/AppScreen", () => {
  const { View } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    AppScreen: ({ children }: { children: ReactNode }) => (
      <View>{children}</View>
    ),
  };
});

jest.mock("@/components/layout/PageHeader", () => {
  const { Text } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    PageHeader: ({ title }: { title: string }) => <Text>{title}</Text>,
  };
});

jest.mock("@/components/history/HistoryTransactionCard", () => {
  const { Text } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    HistoryTransactionCard: ({
      transaction,
    }: {
      transaction: { id: string };
    }) => <Text>{transaction.id}</Text>,
  };
});

jest.mock("@/components/ui/Button", () => {
  const { Pressable, Text } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    Button: ({
      children,
      onPress,
      accessibilityLabel,
      accessibilityState,
    }: {
      children: ReactNode;
      onPress: () => void;
      accessibilityLabel?: string;
      accessibilityState?: { expanded?: boolean };
    }) => (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={accessibilityState}
        onPress={onPress}
      >
        <Text>{children}</Text>
      </Pressable>
    ),
  };
});

jest.mock("@/components/ui/Icon", () => ({ Icon: () => null }));

jest.mock("@/components/ui/StateView", () => {
  const { Text } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    StateView: ({ title }: { title: string }) => <Text>{title}</Text>,
  };
});

function transactionRows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `transaction-${String(index + 1).padStart(2, "0")}`,
    occurredAt: new Date(
      Date.UTC(2026, 7, 2, 8, 0, 0) - index * 60_000,
    ).toISOString(),
  }));
}

describe("History date and month filters", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-08-01T18:30:00.000Z"));
    mockListTransactions.mockResolvedValue([]);
    mockListHistoryPackageOptions.mockResolvedValue([]);
    mockListHistoryCreatorOptions.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("defaults to a bounded Jakarta date and removes weekly and unbounded choices", async () => {
    const screen = render(<HistoryScreen />);

    await waitFor(() => {
      expect(mockListTransactions).toHaveBeenCalledWith({
        limit: 21,
        from: "2026-08-01T17:00:00.000Z",
        to: "2026-08-02T17:00:00.000Z",
      });
    });

    expect(screen.getByText("Tanggal")).toBeTruthy();
    expect(screen.queryByText("Minggu ini")).toBeNull();
    expect(screen.queryByText(/Semua tanggal/i)).toBeNull();
  });

  it("queries the exact selected Jakarta date", async () => {
    const screen = render(<HistoryScreen />);
    await waitFor(() => expect(mockListTransactions).toHaveBeenCalledTimes(1));

    fireEvent.press(
      screen.getByRole("button", {
        name: "Gunakan tanggal 25 Juli 2026",
      }),
    );

    await waitFor(() => {
      expect(mockListTransactions).toHaveBeenLastCalledWith({
        limit: 21,
        from: "2026-07-24T17:00:00.000Z",
        to: "2026-07-25T17:00:00.000Z",
      });
    });
  });

  it("starts collapsed and retains both draft and applied search when hidden", async () => {
    const dismiss = jest.spyOn(Keyboard, "dismiss");
    const screen = render(<HistoryScreen />);
    await waitFor(() => expect(mockListTransactions).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByPlaceholderText("ID transaksi atau nama kasir"),
    ).toBeNull();
    fireEvent.press(
      screen.getByRole("button", { name: "Tampilkan pencarian" }),
    );
    const field = screen.getByPlaceholderText("ID transaksi atau nama kasir");
    fireEvent.changeText(field, "  Andi  ");
    expect(mockListTransactions).toHaveBeenCalledTimes(1);
    fireEvent(field, "submitEditing");
    await waitFor(() =>
      expect(mockListTransactions).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: "Andi" }),
      ),
    );

    fireEvent.changeText(field, "draft belum diterapkan");
    const callsBeforeCollapse = mockListTransactions.mock.calls.length;
    fireEvent.press(
      screen.getByRole("button", { name: "Sembunyikan pencarian" }),
    );
    expect(
      screen.queryByPlaceholderText("ID transaksi atau nama kasir"),
    ).toBeNull();
    expect(screen.getByText("Pencarian: Andi")).toBeTruthy();
    expect(mockListTransactions).toHaveBeenCalledTimes(callsBeforeCollapse);
    expect(dismiss).toHaveBeenCalled();

    fireEvent.press(
      screen.getByRole("button", { name: "Tampilkan pencarian" }),
    );
    expect(
      screen.getByPlaceholderText("ID transaksi atau nama kasir").props.value,
    ).toBe("draft belum diterapkan");
    fireEvent.press(
      screen.getByRole("button", { name: "Sembunyikan pencarian" }),
    );
    fireEvent.press(
      screen.getByRole("button", { name: "Hapus pencarian Andi" }),
    );
    await waitFor(() =>
      expect(mockListTransactions).toHaveBeenLastCalledWith({
        limit: 21,
        from: "2026-08-01T17:00:00.000Z",
        to: "2026-08-02T17:00:00.000Z",
      }),
    );
    expect(screen.queryByText("Pencarian: Andi")).toBeNull();
    fireEvent.press(
      screen.getByRole("button", { name: "Tampilkan pencarian" }),
    );
    expect(
      screen.getByPlaceholderText("ID transaksi atau nama kasir").props.value,
    ).toBe("");
    dismiss.mockRestore();
  });

  it("keeps a hidden search applied to pages and month changes, resetting the cursor", async () => {
    const rows = transactionRows(21);
    mockListTransactions.mockImplementation(
      ({ beforeId }: { beforeId?: string }) =>
        Promise.resolve(
          beforeId
            ? rows.slice(rows.findIndex((row) => row.id === beforeId) + 1)
            : rows,
        ),
    );
    const screen = render(<HistoryScreen />);
    await waitFor(() => expect(mockListTransactions).toHaveBeenCalledTimes(1));
    fireEvent.press(
      screen.getByRole("button", { name: "Tampilkan pencarian" }),
    );
    const field = screen.getByPlaceholderText("ID transaksi atau nama kasir");
    fireEvent.changeText(field, "TX-123");
    fireEvent(field, "submitEditing");
    await waitFor(() => expect(mockListTransactions).toHaveBeenCalledTimes(2));
    fireEvent.press(
      screen.getByRole("button", { name: "Sembunyikan pencarian" }),
    );
    fireEvent.press(
      screen.getByRole("button", { name: "Muat transaksi berikutnya" }),
    );
    await waitFor(() =>
      expect(mockListTransactions).toHaveBeenLastCalledWith(
        expect.objectContaining({
          search: "TX-123",
          beforeId: rows[19]?.id,
          beforeOccurredAt: rows[19]?.occurredAt,
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByText("transaction-21")).toBeTruthy(),
    );
    expect(screen.getAllByText("transaction-01")).toHaveLength(1);
    fireEvent.press(screen.getByRole("button", { name: "Pilih mode bulan" }));
    fireEvent.press(
      screen.getByRole("button", { name: "Gunakan bulan Juni 2026" }),
    );
    await waitFor(() =>
      expect(mockListTransactions).toHaveBeenLastCalledWith({
        limit: 21,
        search: "TX-123",
        from: "2026-05-31T17:00:00.000Z",
        to: "2026-06-30T17:00:00.000Z",
      }),
    );
    expect(
      screen.queryByPlaceholderText("ID transaksi atau nama kasir"),
    ).toBeNull();
    expect(screen.getByText("Pencarian: TX-123")).toBeTruthy();
  });

  it("queries the exact selected Jakarta month", async () => {
    const screen = render(<HistoryScreen />);
    await waitFor(() => expect(mockListTransactions).toHaveBeenCalledTimes(1));

    fireEvent.press(screen.getByRole("button", { name: "Pilih mode bulan" }));
    fireEvent.press(
      screen.getByRole("button", { name: "Gunakan bulan Juni 2026" }),
    );

    await waitFor(() => {
      expect(mockListTransactions).toHaveBeenLastCalledWith({
        limit: 21,
        from: "2026-05-31T17:00:00.000Z",
        to: "2026-06-30T17:00:00.000Z",
      });
    });
    expect(screen.getByText("Bulan")).toBeTruthy();
  });

  it("drops the previous page cursor when the selected date changes", async () => {
    const rows = transactionRows(21);
    const cursorRow = rows[19];
    if (!cursorRow) throw new Error("Expected a full first history page.");
    mockListTransactions
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const screen = render(<HistoryScreen />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Muat transaksi berikutnya" }),
      ).toBeTruthy();
    });
    fireEvent.press(
      screen.getByRole("button", { name: "Muat transaksi berikutnya" }),
    );

    await waitFor(() => expect(mockListTransactions).toHaveBeenCalledTimes(2));
    expect(mockListTransactions).toHaveBeenLastCalledWith({
      limit: 21,
      from: "2026-08-01T17:00:00.000Z",
      to: "2026-08-02T17:00:00.000Z",
      beforeOccurredAt: cursorRow.occurredAt,
      beforeId: cursorRow.id,
    });

    fireEvent.press(
      screen.getByRole("button", {
        name: "Gunakan tanggal 25 Juli 2026",
      }),
    );

    await waitFor(() => expect(mockListTransactions).toHaveBeenCalledTimes(3));
    expect(mockListTransactions).toHaveBeenLastCalledWith({
      limit: 21,
      from: "2026-07-24T17:00:00.000Z",
      to: "2026-07-25T17:00:00.000Z",
    });
  });
});
