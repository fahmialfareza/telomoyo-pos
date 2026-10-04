import {
  act,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react-native";
import type { ReactNode } from "react";
import { BackHandler } from "react-native";

import PrintTransactionScreen from "@/app/(app)/transactions/[id]/print";
import type { Session, Transaction } from "@/domain/types";
import { formatReceipt } from "@/printer/receipt";
import { receiptFromTransaction, type ReceiptDocument } from "@/printer/types";
import type { PrinterConfig } from "@/security/secure-store";
import { colors } from "@/theme/tokens";

const mockSession: Session = {
  token: "token",
  sessionId: "SESSION-1",
  dataMode: "sandbox",
  dataSpaceId: "sandbox-space",
  sandboxGeneration: 1,
  establishedAt: "2026-07-30T01:00:00.000Z",
  user: {
    id: "USER-1",
    fullName: "Admin",
    username: "admin",
    role: "admin",
    active: true,
    mustChangePassword: false,
  },
};
let mockActiveSession = mockSession;
const transaction: Transaction = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  revision: 3,
  occurredAt: "2026-07-30T01:00:00.000Z",
  subtotal: 70_000,
  total: 70_000,
  paymentAmount: 70_000,
  originActorId: "USER-1",
  originActorName: "Admin",
  updatedActorName: "Admin",
  terminalId: "TERMINAL-1",
  syncState: "synced",
  printState: "pending",
  paymentMethod: "qris",
  paymentStatus: "success",
  paymentConfirmedRevision: 3,
  qrisPayloadHash: "hash",
  deletedAt: null,
  items: [
    {
      id: "ITEM-1",
      packageId: "PACKAGE-1",
      packageRevision: 2,
      name: "Paket Harian",
      description: "",
      accent: "standard",
      unitPrice: 70_000,
      quantity: 1,
      lineTotal: 70_000,
    },
  ],
};
let mockTransaction = transaction;
let mockAutoPrint: string | undefined;
let mockConfig: PrinterConfig;
const mockGetTransaction = jest.fn();
const mockQrisDocument = jest.fn();
const mockBeginAttempt = jest.fn();
const mockCompleteAttempt = jest.fn();
const mockConnect = jest.fn();
const mockPrint = jest.fn();
const mockDisconnect = jest.fn();
const mockRelease = jest.fn();
const mockBeginMutation = jest.fn();
const mockReplace = jest.fn();
const mockSync = { refresh: jest.fn(), syncNow: jest.fn() };

jest.mock("expo-router", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    useFocusEffect: (effect: () => void | (() => void)) =>
      React.useEffect(effect, [effect]),
    useLocalSearchParams: () => ({
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      autoPrint: mockAutoPrint,
    }),
    useRouter: () => ({ replace: mockReplace }),
  };
});
jest.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({ session: mockActiveSession }),
}));
jest.mock("@/auth/auth-store", () => ({
  useAuthStore: { getState: () => ({ session: mockActiveSession }) },
}));
jest.mock("@/sync/SyncProvider", () => ({ useSyncRuntime: () => mockSync }));
jest.mock("@/db/repositories", () => ({
  getTransaction: (...args: unknown[]) => mockGetTransaction(...args),
  beginPrintAttempt: (...args: unknown[]) => mockBeginAttempt(...args),
  completePrintAttempt: (...args: unknown[]) => mockCompleteAttempt(...args),
}));
jest.mock("@/tenant/transaction-qris", () => ({
  qrisDocumentForTransaction: (...args: unknown[]) => mockQrisDocument(...args),
}));
jest.mock("@/components/payments/DynamicQrisCard", () => {
  const { Text, View } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    DynamicQrisCard: ({
      payload,
      error,
    }: {
      payload: string | null;
      error: string | null;
    }) => (
      <View testID="print-qris-card">
        <Text>{payload ?? error}</Text>
      </View>
    ),
  };
});
jest.mock("@/security/secure-store", () => ({
  readPrinterConfig: async () => mockConfig,
}));
jest.mock("@/printer/service", () => ({
  getConfiguredPrinter: async () => ({
    config: mockConfig,
    printer: {
      connect: mockConnect,
      print: mockPrint,
      disconnect: mockDisconnect,
    },
  }),
}));
jest.mock("@/mode/mutation-barrier", () => ({
  beginLocalMutation: (...args: unknown[]) => mockBeginMutation(...args),
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
        <View testID="screen-content">{children}</View>
        <View testID="sticky-footer">{stickyFooter}</View>
      </View>
    ),
  };
});
jest.mock("@/components/layout/PageHeader", () => {
  const { Pressable, Text, View } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    PageHeader: ({ title, back }: { title: string; back?: boolean }) => (
      <View>
        {back ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Kembali" />
        ) : null}
        <Text>{title}</Text>
      </View>
    ),
  };
});
jest.mock("@/components/ui/Icon", () => ({ Icon: () => null }));
jest.mock("@/components/ui/PaymentBadge", () => ({
  PaymentMethodBadge: () => null,
}));
jest.mock("@/components/ui/StateView", () => {
  const { Text } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return { StateView: ({ title }: { title: string }) => <Text>{title}</Text> };
});

beforeEach(() => {
  jest.clearAllMocks();
  mockActiveSession = mockSession;
  mockTransaction = transaction;
  mockAutoPrint = undefined;
  mockConfig = {
    adapter: "simulator",
    address: null,
    displayName: "Simulator",
    paperColumns: 32,
  };
  mockGetTransaction.mockImplementation(async () => mockTransaction);
  mockQrisDocument.mockImplementation(() => new Promise(() => undefined));
  mockBeginAttempt.mockResolvedValue("attempt-1");
  mockCompleteAttempt.mockResolvedValue(undefined);
  mockConnect.mockResolvedValue(undefined);
  mockPrint.mockResolvedValue({ status: "success" });
  mockDisconnect.mockResolvedValue(undefined);
  mockBeginMutation.mockReturnValue(mockRelease);
  mockSync.refresh.mockResolvedValue(undefined);
  mockSync.syncNow.mockResolvedValue(undefined);
});

it("shows the bound QRIS above the receipt preview without printing it again", async () => {
  mockQrisDocument.mockResolvedValue({
    transactionId: transaction.id,
    paymentAmount: transaction.paymentAmount,
    orderTotal: transaction.total,
    merchantName: "Merchant Telomoyo",
    merchantCity: "Magelang",
    payload: "bound-dynamic-qris",
    dataMode: "sandbox",
  });
  const screen = render(<PrintTransactionScreen />);
  await screen.findByText("bound-dynamic-qris");
  const content = JSON.stringify(screen.toJSON());
  expect(content.indexOf("print-qris-card")).toBeLessThan(
    content.indexOf("receipt-preview"),
  );
  expect(mockQrisDocument).toHaveBeenCalledWith(transaction, mockSession);
  expect(mockBeginAttempt).not.toHaveBeenCalled();
  expect(mockPrint).not.toHaveBeenCalled();
});

it("does not show a QRIS card for cash payments", async () => {
  mockTransaction = {
    ...transaction,
    paymentMethod: "cash",
    qrisPayloadHash: null,
  };
  const screen = render(<PrintTransactionScreen />);
  await screen.findByTestId("receipt-preview-text");
  expect(screen.queryByTestId("print-qris-card")).toBeNull();
  expect(mockQrisDocument).not.toHaveBeenCalled();
});

it("automatically prints a newly created, paid transaction only once", async () => {
  mockAutoPrint = "1";
  const screen = render(<PrintTransactionScreen />);
  await waitFor(() => expect(mockPrint).toHaveBeenCalledTimes(1));
  await screen.findByText("Simulasi cetak berhasil");
  expect(mockBeginAttempt).toHaveBeenCalledTimes(1);
  expect(mockBeginAttempt.mock.calls[0]?.[0]).toEqual(
    expect.objectContaining({ isCopy: false }),
  );
  fireEvent.press(screen.getByRole("button", { name: "Cetak salinan" }));
  await waitFor(() => expect(mockPrint).toHaveBeenCalledTimes(2));
  expect(mockBeginAttempt.mock.calls[1]?.[0]).toEqual(
    expect.objectContaining({ isCopy: true }),
  );
});

it("marks automatic printing as a copy when a receipt was printed before", async () => {
  mockAutoPrint = "1";
  mockTransaction = { ...transaction, printState: "success" };
  render(<PrintTransactionScreen />);
  await waitFor(() => expect(mockBeginAttempt).toHaveBeenCalledTimes(1));
  expect(mockBeginAttempt.mock.calls[0]?.[0]).toEqual(
    expect.objectContaining({ isCopy: true }),
  );
});

it("does not auto-print a transaction without successful current-revision payment", async () => {
  mockAutoPrint = "1";
  mockTransaction = {
    ...transaction,
    paymentStatus: "pending",
    paymentConfirmedRevision: null,
  };
  render(<PrintTransactionScreen />);
  await waitFor(() => expect(mockGetTransaction).toHaveBeenCalled());
  expect(mockBeginAttempt).not.toHaveBeenCalled();
  expect(mockPrint).not.toHaveBeenCalled();
});

it.each([32, 48] as const)(
  "shows a read-only exact %s-column preview without recording a print attempt",
  async (columns) => {
    mockConfig.paperColumns = columns;
    const screen = render(<PrintTransactionScreen />);
    const output = await screen.findByTestId("receipt-preview-text");
    expect(output.props.children).toBe(
      formatReceipt(
        receiptFromTransaction(transaction, false, "sandbox"),
        columns,
      ),
    );
    expect(screen.getByText(new RegExp(`${columns} kolom`))).toBeTruthy();
    expect(
      screen.getByText(new RegExp(columns === 32 ? "58 mm" : "80 mm")),
    ).toBeTruthy();
    expect(mockGetTransaction).toHaveBeenCalledWith(
      transaction.id,
      mockSession,
    );
    expect(mockBeginAttempt).not.toHaveBeenCalled();
    expect(mockBeginMutation).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockPrint).not.toHaveBeenCalled();
    const footer = within(screen.getByTestId("sticky-footer"));
    expect(footer.getByRole("button", { name: "Cetak struk" })).toHaveStyle({
      backgroundColor: colors.primary,
    });
    expect(footer.getByRole("button", { name: "Cetak nanti" })).toHaveStyle({
      borderColor: colors.primary,
    });
    expect(
      within(screen.getByTestId("screen-content")).queryByRole("button", {
        name: "Cetak struk",
      }),
    ).toBeNull();
  },
);

it.each([32, 48] as const)(
  "preserves Production preview and printer output at %s columns",
  async (columns) => {
    mockConfig.paperColumns = columns;
    mockActiveSession = { ...mockSession, dataMode: "production" };
    const screen = render(<PrintTransactionScreen />);
    const preview = await screen.findByTestId("receipt-preview-text");
    const expected = formatReceipt(
      receiptFromTransaction(transaction, false, "production"),
      columns,
    );
    expect(preview.props.children).toBe(expected);
    expect(expected).not.toContain("TEST - MODE UJI");
    expect(expected).not.toContain("QRIS NYATA");
    fireEvent.press(screen.getByRole("button", { name: "Cetak struk" }));
    await screen.findByText("Simulasi cetak berhasil");
    expect(formatReceipt(mockPrint.mock.calls[0][0], columns)).toBe(expected);
    expect(screen.getByTestId("receipt-preview-text").props.children).toBe(
      expected,
    );
    await waitFor(() => expect(mockRelease).toHaveBeenCalledTimes(1));
  },
);

it.each([32, 48] as const)(
  "retains the legacy Rp1.000 Sandbox payment separately from the order total at %s columns",
  async (columns) => {
    mockConfig.paperColumns = columns;
    mockTransaction = { ...transaction, paymentAmount: 1_000 };
    const screen = render(<PrintTransactionScreen />);
    const preview = await screen.findByTestId("receipt-preview-text");
    const expected = formatReceipt(
      receiptFromTransaction(mockTransaction, false, "sandbox"),
      columns,
    );
    expect(preview.props.children).toBe(expected);
    expect(expected).toMatch(/TOTAL\s+Rp 70\.000/);
    expect(expected).toMatch(/QRIS NYATA\s+Rp 1\.000/);
    expect(expected).toContain("TEST - MODE UJI");
    expect(expected).toContain("BUKAN STRUK RESMI");
    expect(expected.replace(/\n/g, "")).toContain(`TEST-TRX-${transaction.id}`);
    fireEvent.press(screen.getByRole("button", { name: "Cetak struk" }));
    await screen.findByText("Simulasi cetak berhasil");
    const sent = mockPrint.mock.calls[0][0] as ReceiptDocument;
    expect(sent).toMatchObject({ total: 70_000, paymentAmount: 1_000 });
    expect(formatReceipt(sent, columns)).toBe(expected);
    expect(screen.getByTestId("receipt-preview-text").props.children).toBe(
      expected,
    );
    await waitFor(() => expect(mockRelease).toHaveBeenCalledTimes(1));
  },
);

it("defers printing from the sticky footer to history without creating an attempt", async () => {
  const screen = render(<PrintTransactionScreen />);
  await screen.findByTestId("receipt-preview-text");
  fireEvent.press(
    within(screen.getByTestId("sticky-footer")).getByRole("button", {
      name: "Cetak nanti",
    }),
  );
  expect(mockReplace).toHaveBeenCalledWith("/(app)/(tabs)/history");
  expect(mockBeginAttempt).not.toHaveBeenCalled();
  expect(mockPrint).not.toHaveBeenCalled();
});

it("allows summary IDs and amounts to wrap without changing receipt paper layout", async () => {
  const screen = render(<PrintTransactionScreen />);
  const preview = await screen.findByTestId("receipt-preview-text");
  expect(screen.getByTestId("print-summary-header")).toHaveStyle({
    flexWrap: "wrap",
  });
  expect(screen.getByTestId("print-summary-total")).toHaveStyle({
    flexWrap: "wrap",
  });
  expect(preview.props.children).toBe(
    formatReceipt(receiptFromTransaction(transaction, false, "sandbox"), 32),
  );
});

it("describes simulator success and retains the exact document sent, not an accidental copy", async () => {
  const screen = render(<PrintTransactionScreen />);
  await screen.findByTestId("receipt-preview-text");
  fireEvent.press(screen.getByRole("button", { name: "Cetak struk" }));
  expect(await screen.findByText("Simulasi cetak berhasil")).toBeTruthy();
  expect(screen.queryByText("Struk berhasil dicetak!")).toBeNull();
  const sent = mockPrint.mock.calls[0]?.[0] as ReceiptDocument;
  expect(Object.isFrozen(sent)).toBe(true);
  expect(Object.isFrozen(sent.lines)).toBe(true);
  expect(Object.isFrozen(sent.lines[0])).toBe(true);
  expect(sent.isCopy).toBe(false);
  expect(screen.getByTestId("receipt-preview-text").props.children).toBe(
    formatReceipt(sent, 32),
  );
  await waitFor(() => expect(mockRelease).toHaveBeenCalledTimes(1));
  const footer = within(screen.getByTestId("sticky-footer"));
  expect(
    footer.getByRole("button", { name: "Kembali ke Tambah Transaksi" }),
  ).toHaveStyle({ backgroundColor: colors.primary });
  expect(footer.getByRole("button", { name: "Cetak salinan" })).toHaveStyle({
    borderColor: colors.primary,
  });
  fireEvent.press(
    footer.getByRole("button", { name: "Kembali ke Tambah Transaksi" }),
  );
  expect(mockReplace).toHaveBeenCalledWith("/(app)/(tabs)/sell");
  fireEvent.press(screen.getByRole("button", { name: "Cetak salinan" }));
  await waitFor(() => expect(mockPrint).toHaveBeenCalledTimes(2));
  expect(mockPrint.mock.calls[1]?.[0].isCopy).toBe(true);
  await waitFor(() => expect(mockRelease).toHaveBeenCalledTimes(2));
});

it("holds the print barrier until hardware and attempt recording finish", async () => {
  mockConfig.adapter = "integrated";
  const backListener = jest.spyOn(BackHandler, "addEventListener");
  let finishPrint!: (result: { status: "success" }) => void;
  mockPrint.mockReturnValue(
    new Promise((resolve) => {
      finishPrint = resolve;
    }),
  );
  let finishRecording!: () => void;
  mockCompleteAttempt.mockReturnValue(
    new Promise<void>((resolve) => {
      finishRecording = resolve;
    }),
  );
  const screen = render(<PrintTransactionScreen />);
  await screen.findByTestId("receipt-preview-text");
  const handleBack = backListener.mock.calls.find(
    ([event]) => event === "hardwareBackPress",
  )?.[1] as (() => boolean) | undefined;
  expect(handleBack?.()).toBe(false);
  const printButton = screen.getByRole("button", { name: "Cetak struk" });
  act(() => {
    fireEvent.press(printButton);
    fireEvent.press(printButton);
  });
  await waitFor(() => expect(mockPrint).toHaveBeenCalledTimes(1));
  expect(mockBeginAttempt).toHaveBeenCalledTimes(1);
  expect(mockBeginMutation).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Cetak struk" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cetak nanti" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Kembali" })).toBeNull();
  expect(handleBack?.()).toBe(true);
  fireEvent.press(screen.getByRole("button", { name: "Cetak nanti" }));
  expect(mockReplace).not.toHaveBeenCalled();
  expect(mockRelease).not.toHaveBeenCalled();
  await act(async () => {
    finishPrint({ status: "success" });
  });
  expect(mockCompleteAttempt).toHaveBeenCalledTimes(1);
  expect(mockRelease).not.toHaveBeenCalled();
  expect(handleBack?.()).toBe(true);
  expect(screen.getByRole("button", { name: "Cetak nanti" })).toBeDisabled();
  await act(async () => {
    finishRecording();
  });
  expect(await screen.findByText("Struk berhasil dicetak!")).toBeTruthy();
  await waitFor(() => expect(mockRelease).toHaveBeenCalledTimes(1));
  expect(handleBack?.()).toBe(false);
  expect(screen.getByRole("button", { name: "Kembali" })).toBeTruthy();
  backListener.mockRestore();
});

it("finishes a durable print without waiting for sync refresh and disconnects once", async () => {
  let finishRefresh!: () => void;
  mockSync.refresh.mockReturnValue(
    new Promise<void>((resolve) => {
      finishRefresh = resolve;
    }),
  );
  const screen = render(<PrintTransactionScreen />);
  await screen.findByTestId("receipt-preview-text");
  fireEvent.press(screen.getByRole("button", { name: "Cetak struk" }));
  expect(await screen.findByText("Simulasi cetak berhasil")).toBeTruthy();
  expect(mockCompleteAttempt).toHaveBeenCalledTimes(1);
  expect(mockDisconnect).toHaveBeenCalledTimes(1);
  expect(mockRelease).toHaveBeenCalledTimes(1);
  expect(mockSync.refresh).toHaveBeenCalledTimes(1);
  expect(mockSync.syncNow).not.toHaveBeenCalled();
  await act(async () => {
    finishRefresh();
  });
  await waitFor(() => expect(mockSync.syncNow).toHaveBeenCalledTimes(1));
});

it.each(["failed", "unknown"] as const)(
  "records a %s printer result without reporting success or keeping the barrier held",
  async (status) => {
    mockPrint.mockResolvedValue({ status, message: "Printer terputus." });
    const screen = render(<PrintTransactionScreen />);
    await screen.findByTestId("receipt-preview-text");
    fireEvent.press(screen.getByRole("button", { name: "Cetak struk" }));
    await waitFor(() => expect(mockRelease).toHaveBeenCalledTimes(1));
    expect(mockCompleteAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ result: status, error: "Printer terputus." }),
    );
    expect(mockReplace).toHaveBeenCalledWith({
      pathname: "/transactions/[id]/print-failure",
      params: { id: transaction.id, status, message: "Printer terputus." },
    });
    expect(screen.queryByText("Simulasi cetak berhasil")).toBeNull();
    expect(screen.queryByText("Struk berhasil dicetak!")).toBeNull();
  },
);

it("marks a connection failure and always releases the print barrier", async () => {
  mockConnect.mockRejectedValue(new Error("Printer tidak tersambung."));
  const screen = render(<PrintTransactionScreen />);
  await screen.findByTestId("receipt-preview-text");
  fireEvent.press(screen.getByRole("button", { name: "Cetak struk" }));
  expect(await screen.findByText("Printer tidak tersambung.")).toBeTruthy();
  expect(mockPrint).not.toHaveBeenCalled();
  expect(mockCompleteAttempt).toHaveBeenCalledWith(
    expect.objectContaining({
      result: "failed",
      error: "Printer tidak tersambung.",
    }),
  );
  await waitFor(() => expect(mockRelease).toHaveBeenCalledTimes(1));
});
