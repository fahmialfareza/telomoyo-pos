import { fireEvent, render, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";

import PrintQrisScreen from "@/app/(app)/transactions/[id]/print-qris";

const mockReplace = jest.fn();
const mockGetTransaction = jest.fn();
const mockHasBlock = jest.fn();
const mockPayload = jest.fn();
const mockReadQrisConfig = jest.fn();
const mockPrintQris = jest.fn();
const mockConnect = jest.fn();
const mockDisconnect = jest.fn();
const mockRelease = jest.fn();
const mockSession = {
  sessionId: "SESSION-1",
  tenantId: "TENANT-1",
  dataMode: "production",
};

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ id: "TX-1" }),
  useRouter: () => ({ replace: mockReplace }),
}));
jest.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({ session: mockSession }),
}));
jest.mock("@/db/repositories", () => ({
  getTransaction: (...args: unknown[]) => mockGetTransaction(...args),
  hasTerminalTransactionBlock: (...args: unknown[]) => mockHasBlock(...args),
}));
jest.mock("@/tenant/configuration", () => ({
  qrisPayloadForTransaction: (...args: unknown[]) => mockPayload(...args),
}));
jest.mock("@/security/secure-store", () => ({
  readQrisConfig: (...args: unknown[]) => mockReadQrisConfig(...args),
}));
jest.mock("@/domain/qris", () => ({
  fingerprintStaticQris: async () => "hash-1",
  validateStaticQris: () => ({ payload: "static-payload" }),
  createDynamicQris: (_payload: string, amount: number) => ({
    payload: `dynamic-${amount}`,
    merchantName: "Merchant Telomoyo",
    merchantCity: "Magelang",
  }),
}));
jest.mock("@/printer/service", () => ({
  getConfiguredPrinter: async () => ({
    config: { address: null, adapter: "simulator" },
    printer: {
      connect: mockConnect,
      printQris: mockPrintQris,
      disconnect: mockDisconnect,
    },
  }),
}));
jest.mock("@/mode/mutation-barrier", () => ({
  beginLocalMutation: () => mockRelease,
}));
jest.mock("@/mode/mode-store", () => ({
  useModeStore: { getState: () => ({ accessBlocked: false }) },
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
        {stickyFooter}
      </View>
    ),
  };
});
jest.mock("@/components/layout/PageHeader", () => ({ PageHeader: () => null }));
jest.mock("@/components/payments/DynamicQrisCard", () => ({
  DynamicQrisCard: () => null,
}));
jest.mock("@/components/ui/StateView", () => ({ StateView: () => null }));
jest.mock("@/components/ui/Button", () => {
  const { Pressable, Text } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    Button: ({
      children,
      onPress,
      disabled,
    }: {
      children: ReactNode;
      onPress: () => void;
      disabled?: boolean;
    }) => (
      <Pressable
        accessibilityRole="button"
        disabled={disabled}
        onPress={onPress}
      >
        <Text>{children}</Text>
      </Pressable>
    ),
  };
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetTransaction.mockResolvedValue({
    id: "TX-1",
    paymentMethod: "qris",
    paymentAmount: 70_000,
    total: 70_000,
    revision: 1,
    paymentStatus: "success",
    paymentConfirmedRevision: 1,
    qrisPayloadHash: "hash-1",
    deletedAt: null,
    syncState: "pending",
  });
  mockHasBlock.mockResolvedValue(false);
  mockPayload.mockResolvedValue("static-payload");
  mockReadQrisConfig.mockResolvedValue(null);
  mockConnect.mockResolvedValue(undefined);
  mockPrintQris.mockResolvedValue({ status: "success" });
  mockDisconnect.mockResolvedValue(undefined);
});

it("prints the exact amount QRIS job before navigating to automatic receipt printing", async () => {
  render(<PrintQrisScreen />);
  await waitFor(() => expect(mockReplace).toHaveBeenCalledTimes(1));
  expect(mockPrintQris).toHaveBeenCalledWith(
    expect.objectContaining({
      transactionId: "TX-1",
      paymentAmount: 70_000,
      payload: "dynamic-70000",
    }),
  );
  expect(mockDisconnect).toHaveBeenCalledTimes(1);
  expect(mockRelease).toHaveBeenCalledTimes(1);
  expect(mockReplace).toHaveBeenCalledWith({
    pathname: "/transactions/[id]/print",
    params: { id: "TX-1", autoPrint: "1" },
  });
});

it("does not print a receipt if QRIS printing fails, and offers retry", async () => {
  mockPrintQris.mockResolvedValueOnce({
    status: "failed",
    message: "Printer tidak siap",
  });
  const screen = render(<PrintQrisScreen />);
  await screen.findByText("Printer tidak siap");
  expect(mockReplace).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole("button", { name: "Coba lagi cetak QRIS" }));
  await waitFor(() => expect(mockReplace).toHaveBeenCalledTimes(1));
  expect(mockPrintQris).toHaveBeenCalledTimes(2);
});

it("refuses to print if the historical merchant payload is missing", async () => {
  mockPayload.mockResolvedValue(null);
  render(<PrintQrisScreen />);
  await waitFor(() => expect(mockPayload).toHaveBeenCalled());
  expect(mockPrintQris).not.toHaveBeenCalled();
  expect(mockReplace).not.toHaveBeenCalled();
});

it("accepts a matching encrypted local QRIS source when historical cache is unavailable", async () => {
  mockPayload.mockResolvedValue(null);
  mockReadQrisConfig.mockResolvedValue({ staticPayload: "static-payload" });
  render(<PrintQrisScreen />);
  await waitFor(() => expect(mockReplace).toHaveBeenCalledTimes(1));
  expect(mockPrintQris).toHaveBeenCalledTimes(1);
});
