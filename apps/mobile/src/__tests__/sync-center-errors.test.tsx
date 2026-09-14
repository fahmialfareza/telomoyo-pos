import {
  fireEvent,
  render as renderScreen,
  waitFor,
} from "@testing-library/react-native";
import type { ReactNode } from "react";
import { ConfirmationProvider } from "@/components/ui/ConfirmationProvider";

import SyncCenterScreen from "@/app/(app)/sync";
import { SERVER_UNREACHABLE_MESSAGE } from "@/utils/errors";

const mockNativeConnectionMessage =
  "fetch failed: java.net.ConnectException: Failed to connect to /192.168.18.254:8080";
const mockSession = {
  tenantId: "00000000-0000-4000-8000-000000000200",
  user: { fullName: "Andi" },
};
jest.mock("@/auth/auth-store", () => ({
  useAuthStore: Object.assign(
    (select: (state: { session: typeof mockSession }) => unknown) =>
      select({ session: mockSession }),
    {
      getState: () => ({ session: mockSession }),
      subscribe: () => () => undefined,
    },
  ),
}));
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));

function render(element: React.ReactElement) {
  return renderScreen(element, { wrapper: ConfirmationProvider });
}
jest.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({ session: mockSession }),
}));
jest.mock("@/tenant/quarantine", () => ({
  countQuarantinedOperations: async () => 0,
}));
const mockRefresh = jest.fn(() => Promise.resolve());
const mockSyncNow = jest.fn(() =>
  Promise.reject(new Error(mockNativeConnectionMessage)),
);
const mockRuntime = {
  online: true,
  pendingCount: 2,
  syncing: false,
  lastSyncedAt: null,
  lastError: mockNativeConnectionMessage as string | null,
  lastSummary: null,
  refresh: mockRefresh,
  syncNow: mockSyncNow,
};

jest.mock("expo-router", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    useRouter: () => ({ push: jest.fn() }),
    useFocusEffect: (effect: () => void | (() => void)) =>
      React.useEffect(effect, [effect]),
  };
});

jest.mock("@/sync/SyncProvider", () => ({
  useSyncRuntime: () => mockRuntime,
}));

jest.mock("@/db/repositories", () => ({
  discardRejectedOutboxOperation: jest.fn(),
  getSyncMetadata: () =>
    Promise.resolve({
      cursor: null,
      lastSyncedAt: null,
      lastError: mockNativeConnectionMessage,
    }),
  listConflicts: () => Promise.resolve([]),
  listRejectedOutboxOperations: () => Promise.resolve([]),
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
      disabled,
      onPress,
    }: {
      children: ReactNode;
      disabled?: boolean;
      onPress?: () => void;
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

jest.mock("@/components/ui/StatusBadge", () => ({
  StatusBadge: () => null,
}));

describe("Sync Center connection errors", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRuntime.lastError = mockNativeConnectionMessage;
    mockSyncNow.mockRejectedValue(new Error(mockNativeConnectionMessage));
  });

  it("hides native details and safely handles manual retry", async () => {
    const screen = render(<SyncCenterScreen />);

    expect(screen.getByText("Sinkronisasi belum berhasil")).toBeTruthy();
    expect(screen.getByText(SERVER_UNREACHABLE_MESSAGE)).toBeTruthy();
    expect(screen.queryByText(mockNativeConnectionMessage)).toBeNull();
    expect(
      screen.getByText(
        "Data lokal tetap tersimpan dan sinkronisasi otomatis akan mencoba lagi.",
      ),
    ).toBeTruthy();

    fireEvent.press(screen.getByRole("button", { name: "Sinkron sekarang" }));

    await waitFor(() => {
      expect(mockSyncNow).toHaveBeenCalledTimes(1);
      expect(mockRefresh).toHaveBeenCalled();
    });
  });
});
