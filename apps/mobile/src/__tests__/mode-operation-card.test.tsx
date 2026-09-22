import { fireEvent, render, waitFor } from "@testing-library/react-native";

import { ModeOperationCard } from "@/components/settings/ModeOperationCard";
import type { Session } from "@/domain/types";

const mockApiRequest = jest.fn();
const mockRefetch = jest.fn();
const mockSwitchMode = jest.fn();
const mockSession: Session = {
  token: "production-token",
  sessionId: "production-session",
  contextKind: "tenant",
  tenantId: "00000000-0000-4000-8000-000000000200",
  membershipId: "00000000-0000-4000-8000-000000000201",
  establishedAt: "2026-09-23T00:00:00Z",
  dataMode: "production",
  dataSpaceId: "00000000-0000-4000-8000-000000000100",
  sandboxGeneration: null,
  protocolVersion: 3,
  sandboxQrisPolicy: "transaction_total",
  user: {
    id: "superadmin-1",
    fullName: "Super Admin",
    username: "superadmin",
    role: "superadmin",
    active: true,
    mustChangePassword: false,
  },
};

let mockActiveSession = mockSession;
let mockSandboxEnabled = false;

jest.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: {
      enabled: mockSandboxEnabled,
      dataMode: "sandbox",
      dataSpaceId: mockSandboxEnabled
        ? "00000000-0000-4000-8000-000000000202"
        : null,
      generation: mockSandboxEnabled ? 1 : null,
      retentionDays: 30,
      qrisAmount: null,
      sandboxQrisPolicy: "transaction_total",
    },
    error: null,
    isLoading: false,
    refetch: mockRefetch,
  }),
}));
jest.mock("expo-router", () => ({
  useFocusEffect: (callback: () => void) => callback(),
}));
jest.mock("@/api/client", () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}));
jest.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({
    session: mockActiveSession,
    switchMode: mockSwitchMode,
    upgradeSession: jest.fn(),
    switchingMode: false,
  }),
}));
jest.mock("@/sync/SyncProvider", () => ({
  useSyncRuntime: () => ({
    syncing: false,
    pendingCount: 0,
    refresh: jest.fn(),
  }),
}));
jest.mock("@/components/ui/Icon", () => ({ Icon: () => null }));

describe("ModeOperationCard Sandbox configuration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockActiveSession = mockSession;
    mockSandboxEnabled = false;
    mockRefetch.mockResolvedValue(undefined);
    mockApiRequest.mockResolvedValue({
      enabled: true,
      dataMode: "sandbox",
      dataSpaceId: "00000000-0000-4000-8000-000000000202",
      generation: 1,
      retentionDays: 30,
      qrisAmount: null,
      sandboxQrisPolicy: "transaction_total",
    });
  });

  it("lets a Production Superadmin enable Sandbox for the selected business", async () => {
    const screen = render(<ModeOperationCard />);

    fireEvent.press(screen.getByRole("button", { name: "Aktifkan Mode Uji" }));

    await waitFor(() =>
      expect(mockApiRequest).toHaveBeenCalledWith("/sandbox/settings", {
        method: "PUT",
        token: mockSession.token,
        body: { enabled: true },
      }),
    );
    expect(mockRefetch).toHaveBeenCalled();
    expect(screen.getByText(/Mode Uji diaktifkan/)).toBeTruthy();
  });

  it("hides the card from an Admin when Sandbox is disabled", () => {
    mockActiveSession = {
      ...mockSession,
      user: { ...mockSession.user, role: "admin" },
    };
    const screen = render(<ModeOperationCard />);

    expect(screen.queryByText("MODE OPERASI")).toBeNull();
  });

  it("shows the card to an Admin when Sandbox is enabled", () => {
    mockSandboxEnabled = true;
    mockActiveSession = {
      ...mockSession,
      user: { ...mockSession.user, role: "admin" },
    };
    const screen = render(<ModeOperationCard />);

    expect(screen.getByText("MODE OPERASI")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Nonaktifkan Mode Uji" }),
    ).toBeNull();
  });
});
