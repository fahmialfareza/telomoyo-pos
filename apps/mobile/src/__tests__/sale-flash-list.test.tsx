import {
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react-native";
import type { ReactNode } from "react";

import SaleComposerScreen from "@/app/(app)/(tabs)/sell";

const mockListPackages = jest.fn();
const mockReadQrisConfig = jest.fn();
const mockCreateTransaction = jest.fn();
const mockPush = jest.fn();
const mockRefresh = jest.fn();
const mockSyncNow = jest.fn();
const mockSession = {
  tenantId: "00000000-0000-4000-8000-000000000200",
  dataMode: "production",
  user: { fullName: "Andi" },
};
const STATIC_QRIS =
  "00020101021126320014ID.CO.TEST.WWW011012345678905204729953033605802ID5910SEWA MOTOR6008DENPASAR6304AA64";

jest.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  CryptoEncoding: { HEX: "hex" },
  digestStringAsync: jest.fn(async () => "a".repeat(64)),
}));

jest.mock("@shopify/flash-list", () => {
  const { View } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    FlashList: function FlashListMock({
      data,
      renderItem,
      ListHeaderComponent,
      ListEmptyComponent,
    }: {
      data: { id: string }[];
      renderItem: (value: {
        item: { id: string };
        index: number;
        target: "Cell";
      }) => ReactNode;
      ListHeaderComponent?: ReactNode;
      ListEmptyComponent?: ReactNode;
    }) {
      return (
        <View>
          {ListHeaderComponent}
          {data.length === 0
            ? ListEmptyComponent
            : data.map((item, index) => (
                <View key={item.id}>
                  {renderItem({ item, index, target: "Cell" })}
                </View>
              ))}
        </View>
      );
    },
  };
});
jest.mock("expo-router", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    useRouter: () => ({ push: mockPush }),
    useFocusEffect: (effect: () => void | (() => void)) =>
      React.useEffect(effect, [effect]),
  };
});
jest.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({ session: mockSession }),
}));
jest.mock("@/db/repositories", () => ({
  listPackages: (...args: unknown[]) => mockListPackages(...args),
  createTransaction: (...args: unknown[]) => mockCreateTransaction(...args),
}));
jest.mock("@/security/secure-store", () => ({
  readQrisConfig: () => mockReadQrisConfig(),
}));
jest.mock("@/sync/SyncProvider", () => ({
  useSyncRuntime: () => ({ refresh: mockRefresh, syncNow: mockSyncNow }),
}));
jest.mock("@/components/layout/AppScreen", () => {
  const { View } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    AppScreen: ({
      children,
      stickyFooter,
    }: {
      children: ReactNode;
      stickyFooter?: ReactNode;
    }) => (
      <View>
        {children}
        <View testID="sale-summary">{stickyFooter}</View>
      </View>
    ),
  };
});
jest.mock("@/components/layout/PageHeader", () => {
  const { Text } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return { PageHeader: ({ title }: { title: string }) => <Text>{title}</Text> };
});
jest.mock("@/components/ui/Icon", () => ({ Icon: () => null }));

beforeEach(() => {
  jest.clearAllMocks();
  mockReadQrisConfig.mockResolvedValue(null);
  mockRefresh.mockResolvedValue(undefined);
  mockSyncNow.mockResolvedValue(undefined);
  mockCreateTransaction.mockResolvedValue({ id: "transaction-1" });
  mockListPackages.mockResolvedValue([
    {
      id: "package-a",
      revision: 1,
      name: "Paket A",
      description: "Pertama",
      unitPrice: 20_000,
      accent: "standard",
      active: true,
      deletedAt: null,
    },
    {
      id: "package-b",
      revision: 1,
      name: "Paket B",
      description: "Kedua",
      unitPrice: 100_000,
      accent: "sunrise",
      active: true,
      deletedAt: null,
    },
  ]);
});

it("keeps package quantities and the sticky total aligned after list updates", async () => {
  const screen = render(<SaleComposerScreen />);
  await screen.findByText("Paket A");
  await screen.findByText("Paket B");
  const increment = screen.getAllByRole("button", { name: "Tambah jumlah" });
  fireEvent.press(increment[0]!);
  fireEvent.press(increment[0]!);
  fireEvent.press(increment[1]!);
  const summary = screen.getByTestId("sale-summary");
  expect(within(summary).queryByText("RINGKASAN")).toBeNull();
  expect(within(summary).queryByText("2 paket • 3 item")).toBeNull();
  expect(within(summary).queryByText("Simpan transaksi")).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Tampilkan ringkasan" }));
  expect(within(summary).getByText("2 paket • 3 item")).toBeTruthy();
  expect(within(summary).getByText("Rp 140.000")).toBeTruthy();
  fireEvent.press(
    screen.getAllByRole("button", { name: "Kurangi jumlah" })[0]!,
  );
  expect(within(summary).getByText("2 paket • 2 item")).toBeTruthy();
  expect(within(summary).getByText("Rp 120.000")).toBeTruthy();
});

it("saves once when a payment method is tapped twice and opens automatic printing", async () => {
  let completeSave: ((value: { id: string }) => void) | undefined;
  mockCreateTransaction.mockImplementation(
    () =>
      new Promise((resolve) => {
        completeSave = resolve;
      }),
  );
  const screen = render(<SaleComposerScreen />);
  await screen.findByText("Paket A");
  fireEvent.press(screen.getAllByRole("button", { name: "Tambah jumlah" })[0]!);
  const cash = screen.getByRole("radio", { name: "Tunai" });
  fireEvent.press(cash);
  fireEvent.press(cash);
  expect(mockCreateTransaction).toHaveBeenCalledTimes(1);
  expect(mockCreateTransaction.mock.calls[0]?.[1]).toBe("cash");
  completeSave?.({ id: "transaction-1" });
  await waitFor(() =>
    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/transactions/[id]/print",
      params: { id: "transaction-1", autoPrint: "1" },
    }),
  );
});

it("does not create a transaction without selected packages", async () => {
  const screen = render(<SaleComposerScreen />);
  await screen.findByText("Paket A");
  const cash = screen.getByRole("radio", { name: "Tunai" });
  expect(cash.props.accessibilityState.disabled).toBe(true);
  fireEvent.press(cash);
  expect(mockCreateTransaction).not.toHaveBeenCalled();
});

it("opens QRIS printing before receipt printing after QRIS selection", async () => {
  mockReadQrisConfig.mockResolvedValue({ staticPayload: STATIC_QRIS });
  const screen = render(<SaleComposerScreen />);
  await screen.findByText("Paket A");
  fireEvent.press(screen.getAllByRole("button", { name: "Tambah jumlah" })[0]!);
  const qris = screen.getByRole("radio", { name: "QRIS" });
  await waitFor(() =>
    expect(qris.props.accessibilityState.disabled).toBe(false),
  );
  fireEvent.press(qris);
  await waitFor(() => expect(mockCreateTransaction).toHaveBeenCalledTimes(1));
  expect(mockCreateTransaction.mock.calls[0]?.[1]).toBe("qris");
  await waitFor(() =>
    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/transactions/[id]/print-qris",
      params: { id: "transaction-1" },
    }),
  );
});
