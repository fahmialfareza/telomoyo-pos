import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";

import HomeScreen from "@/app/(app)/(tabs)/home";
import type { DashboardStats } from "@/domain/types";
import type { ReportingRange } from "@/utils/time";

const mockGetDashboardStats = jest.fn<
  Promise<DashboardStats>,
  [ReportingRange]
>();
const mockListTransactions = jest.fn();
const mockRouterPush = jest.fn();
const mockSession = {
  tenantId: "00000000-0000-4000-8000-000000000200",
  user: { fullName: "Andi" },
};
const mockSyncRuntime = {
  lastSyncedAt: null as string | null,
  pendingCount: 0,
};

jest.mock("expo-router", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    useRouter: () => ({ push: mockRouterPush }),
    useFocusEffect: (effect: () => void | (() => void)) =>
      React.useEffect(effect, [effect]),
  };
});

jest.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({
    session: mockSession,
  }),
}));

jest.mock("@/sync/SyncProvider", () => ({
  useSyncRuntime: () => mockSyncRuntime,
}));

jest.mock("@/components/reporting/DateMonthFilter", () => {
  const { Pressable, Text, View } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    DateMonthFilter: ({
      date,
      mode,
      month,
      onDateChange,
      onModeChange,
      onMonthChange,
    }: {
      date: string;
      mode: "date" | "month";
      month: string;
      onDateChange: (date: string) => void;
      onModeChange: (mode: "date" | "month") => void;
      onMonthChange: (month: string) => void;
    }) => (
      <View>
        <Pressable
          accessibilityLabel="Gunakan filter tanggal"
          accessibilityRole="button"
          onPress={() => onModeChange("date")}
        >
          <Text>Tanggal</Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Gunakan filter bulan"
          accessibilityRole="button"
          onPress={() => onModeChange("month")}
        >
          <Text>Bulan</Text>
        </Pressable>
        {mode === "date" ? (
          <Pressable
            accessibilityLabel="Pilih tanggal pengujian"
            accessibilityRole="button"
            onPress={() => onDateChange("2026-07-15")}
          >
            <Text>{date}</Text>
          </Pressable>
        ) : (
          <Pressable
            accessibilityLabel="Pilih bulan pengujian"
            accessibilityRole="button"
            onPress={() => onMonthChange("2026-06")}
          >
            <Text>{month}</Text>
          </Pressable>
        )}
      </View>
    ),
  };
});

jest.mock("@/db/repositories", () => ({
  getDashboardStats: (range: ReportingRange) => mockGetDashboardStats(range),
  listTransactions: (...args: unknown[]) => mockListTransactions(...args),
}));

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

jest.mock("@/components/transactions/TransactionRow", () => ({
  TransactionRow: () => null,
}));

jest.mock("@/components/ui/Card", () => {
  const { View } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    Card: ({ children }: { children: ReactNode }) => <View>{children}</View>,
  };
});

jest.mock("@/components/ui/Button", () => {
  const { Pressable, Text } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    Button: ({
      children,
      onPress,
    }: {
      children: ReactNode;
      onPress: () => void;
    }) => (
      <Pressable accessibilityRole="button" onPress={onPress}>
        <Text>{children}</Text>
      </Pressable>
    ),
  };
});

const emptyStats: DashboardStats = {
  gross: 0,
  actualQrisAmount: 0,
  cashAmount: 0,
  transactionCount: 0,
  quantities: [],
  buckets: Array(24).fill(0),
};

const populatedStats: DashboardStats = {
  gross: 170_000,
  actualQrisAmount: 0,
  cashAmount: 170_000,
  transactionCount: 2,
  quantities: [
    {
      name: "Paket Standar",
      quantity: 3,
      accent: "standard",
      revenue: 170_000,
    },
  ],
  buckets: [...Array(23).fill(0), 170_000],
};

describe("Home dashboard refresh", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetDashboardStats.mockReset();
    mockListTransactions.mockReset();
    mockSyncRuntime.lastSyncedAt = null;
    mockSyncRuntime.pendingCount = 0;
    mockListTransactions.mockResolvedValue([]);
  });

  it("shows the Dasbor title and loads an explicitly selected date or month", async () => {
    mockGetDashboardStats.mockResolvedValue(emptyStats);
    const screen = render(<HomeScreen />);

    await waitFor(() => {
      expect(mockGetDashboardStats).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText("Dasbor")).toBeTruthy();
    expect(screen.queryByText("Dasbor Toko")).toBeNull();
    expect(screen.queryByText("Mingguan")).toBeNull();

    fireEvent.press(
      screen.getByRole("button", { name: "Pilih tanggal pengujian" }),
    );

    await waitFor(() => {
      expect(mockGetDashboardStats).toHaveBeenLastCalledWith({
        mode: "date",
        from: "2026-07-14T17:00:00.000Z",
        to: "2026-07-15T17:00:00.000Z",
      });
    });

    fireEvent.press(
      screen.getByRole("button", { name: "Gunakan filter bulan" }),
    );
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Pilih bulan pengujian" }),
      ).toBeTruthy();
    });
    fireEvent.press(
      screen.getByRole("button", { name: "Pilih bulan pengujian" }),
    );

    await waitFor(() => {
      expect(mockGetDashboardStats).toHaveBeenLastCalledWith({
        mode: "month",
        from: "2026-05-31T17:00:00.000Z",
        to: "2026-06-30T17:00:00.000Z",
      });
    });
  });

  it("reloads while focused after sync and uses the live outbox count", async () => {
    mockGetDashboardStats
      .mockResolvedValueOnce(emptyStats)
      .mockResolvedValueOnce(populatedStats);
    const screen = render(<HomeScreen />);

    await waitFor(() => {
      expect(screen.getByText("0 transaksi lunas")).toBeTruthy();
    });

    mockSyncRuntime.lastSyncedAt = "2026-07-29T11:00:00.000Z";
    mockSyncRuntime.pendingCount = 2;
    screen.rerender(<HomeScreen />);

    await waitFor(() => {
      expect(screen.getByText(/170\.000/)).toBeTruthy();
      expect(screen.getByText("2 transaksi lunas")).toBeTruthy();
      expect(screen.getByText("3 unit")).toBeTruthy();
      expect(screen.getByText("2 perubahan")).toBeTruthy();
    });
    expect(mockGetDashboardStats).toHaveBeenCalledTimes(2);
  });

  it("ignores an older zero response that finishes after a synced response", async () => {
    let resolveInitial: (value: DashboardStats) => void = () => {
      throw new Error("Initial dashboard resolver was not initialized.");
    };
    mockGetDashboardStats
      .mockImplementationOnce(
        () =>
          new Promise<DashboardStats>((resolve) => {
            resolveInitial = resolve;
          }),
      )
      .mockResolvedValueOnce(populatedStats);
    const screen = render(<HomeScreen />);

    await waitFor(() => {
      expect(mockGetDashboardStats).toHaveBeenCalledTimes(1);
    });

    mockSyncRuntime.lastSyncedAt = "2026-07-29T11:00:00.000Z";
    screen.rerender(<HomeScreen />);

    await waitFor(() => {
      expect(screen.getByText("2 transaksi lunas")).toBeTruthy();
    });

    await act(async () => {
      resolveInitial(emptyStats);
    });

    expect(screen.getByText("2 transaksi lunas")).toBeTruthy();
    expect(screen.queryByText("0 transaksi lunas")).toBeNull();
  });

  it("shows a retry instead of silently keeping the initial zero state", async () => {
    mockGetDashboardStats
      .mockRejectedValueOnce(new Error("Database sedang sibuk."))
      .mockResolvedValueOnce(populatedStats);
    const screen = render(<HomeScreen />);

    await waitFor(() => {
      expect(screen.getByText("Ringkasan belum diperbarui")).toBeTruthy();
      expect(screen.getByText("Database sedang sibuk.")).toBeTruthy();
    });

    fireEvent.press(screen.getByRole("button", { name: "Coba lagi" }));

    await waitFor(() => {
      expect(screen.getByText("2 transaksi lunas")).toBeTruthy();
      expect(screen.queryByText("Ringkasan belum diperbarui")).toBeNull();
    });
  });
});
