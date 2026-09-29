import { fireEvent, render, within } from "@testing-library/react-native";
import type { ReactNode } from "react";

import SaleComposerScreen from "@/app/(app)/(tabs)/sell";

const mockListPackages = jest.fn();
const mockReadQrisConfig = jest.fn();
const mockSession = {
  tenantId: "00000000-0000-4000-8000-000000000200",
  dataMode: "production",
  user: { fullName: "Andi" },
};

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
    useRouter: () => ({ push: jest.fn() }),
    useFocusEffect: (effect: () => void | (() => void)) =>
      React.useEffect(effect, [effect]),
  };
});
jest.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({ session: mockSession }),
}));
jest.mock("@/db/repositories", () => ({
  listPackages: (...args: unknown[]) => mockListPackages(...args),
  createTransaction: jest.fn(),
}));
jest.mock("@/security/secure-store", () => ({
  readQrisConfig: () => mockReadQrisConfig(),
}));
jest.mock("@/sync/SyncProvider", () => ({
  useSyncRuntime: () => ({ refresh: jest.fn(), syncNow: jest.fn() }),
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
  expect(within(summary).getByText("2 paket • 3 item")).toBeTruthy();
  expect(within(summary).getByText("Rp 140.000")).toBeTruthy();
  fireEvent.press(
    screen.getAllByRole("button", { name: "Kurangi jumlah" })[0]!,
  );
  expect(within(summary).getByText("2 paket • 2 item")).toBeTruthy();
  expect(within(summary).getByText("Rp 120.000")).toBeTruthy();
});
