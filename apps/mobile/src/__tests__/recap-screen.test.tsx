import { act, fireEvent, render } from "@testing-library/react-native";
import type { ReactNode } from "react";

import RecapScreen from "@/app/(app)/reports/recap";
import { SimulatorPrinter } from "@/printer/simulator";

const mockGetDashboardStats = jest.fn();
const mockPrinter = new SimulatorPrinter("success", 32);
let mockPendingCount = 0;
// Stable like the real AuthProvider session, so focus effects don't refire.
const mockSession = {
  dataMode: "production",
  tenant: { name: "Sewa Motor Telomoyo" },
  user: { fullName: "Andi" },
};

jest.mock("expo-router", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
    useFocusEffect: (effect: () => void | (() => void)) =>
      React.useEffect(effect, [effect]),
  };
});
jest.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({ session: mockSession }),
}));
jest.mock("@/db/repositories", () => ({
  getDashboardStats: (...args: unknown[]) => mockGetDashboardStats(...args),
}));
jest.mock("@/printer/service", () => ({
  getConfiguredPrinter: async () => ({
    config: { address: null, paperColumns: 32 },
    printer: mockPrinter,
  }),
}));
jest.mock("@/sync/SyncProvider", () => ({
  useSyncRuntime: () => ({ pendingCount: mockPendingCount }),
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
  return { PageHeader: ({ title }: { title: string }) => <Text>{title}</Text> };
});
jest.mock("@/components/reporting/DateMonthFilter", () => ({
  ...jest.requireActual("@/components/reporting/DateMonthFilter"),
  DateMonthFilter: () => null,
}));
jest.mock("@/components/ui/Icon", () => ({ Icon: () => null }));

const stats = {
  gross: 340_000,
  actualQrisAmount: 200_000,
  cashAmount: 140_000,
  transactionCount: 3,
  quantities: [
    {
      name: "Paket Standar",
      quantity: 7,
      accent: "standard",
      revenue: 140_000,
    },
  ],
  buckets: [],
};

beforeEach(() => {
  mockGetDashboardStats.mockReset().mockResolvedValue(stats);
  mockPrinter.lastOutput = null;
  mockPendingCount = 0;
});

it("shows totals, the cash/QRIS split and per-package revenue", async () => {
  const screen = render(<RecapScreen />);
  expect(await screen.findByText("Rp 340.000")).toBeTruthy();
  expect(screen.getByText("3 transaksi lunas")).toBeTruthy();
  expect(screen.getAllByText("Rp 140.000")).toHaveLength(2);
  expect(screen.getByText("Rp 200.000")).toBeTruthy();
  expect(screen.getByText("7 unit")).toBeTruthy();
  expect(screen.queryByText(/belum sinkron/)).toBeNull();
});

it("warns about unsynced changes and prints the recap", async () => {
  mockPendingCount = 2;
  const screen = render(<RecapScreen />);
  await screen.findByText("Rp 340.000");
  expect(screen.getByText(/2 perubahan belum sinkron/)).toBeTruthy();

  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Cetak rekap" }));
  });
  expect(screen.getByText("Rekap dicetak.")).toBeTruthy();
  expect(mockPrinter.lastOutput).toContain("REKAP HARIAN");
  expect(mockPrinter.lastOutput).toContain("Sewa Motor Telomoyo");
  expect(mockPrinter.lastOutput?.replace(/\s+/g, " ")).toContain(
    "2 perubahan belum sinkron",
  );
});
