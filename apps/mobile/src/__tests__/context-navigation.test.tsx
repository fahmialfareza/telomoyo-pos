import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { BackHandler } from "react-native";
import type { Session } from "@/domain/types";
import { useAuthStore } from "@/auth/auth-store";
import {
  navigateContext,
  retryContextNavigation,
} from "@/navigation/context-navigation-actions";
import {
  beginContextNavigation,
  completeContextNavigation,
  consumeContextDestination,
  resetContextNavigation,
  useContextNavigationStore,
} from "@/navigation/context-navigation-store";
import {
  ContextNavigationCoordinator,
  ContextNavigationFeedback,
  ContextNavigationLifecycle,
} from "@/navigation/context-navigation";
import TabsLayout from "@/app/(app)/(tabs)/_layout";
import ManagementLayout from "@/app/management/_layout";

const mockSwitchContext = jest.fn();
const mockApiRequest = jest.fn();
const mockReplace = jest.fn();
const mockPush = jest.fn();
const mockRouter = { replace: mockReplace, push: mockPush };
let mockPathname = "/home";
let mockNavigationKey: string | undefined = "root";

jest.mock("@/auth/auth-store", () => ({
  useAuthStore: jest.requireActual("zustand").create(() => ({
    session: null,
    switchingMode: false,
    scopeLocked: false,
    bootError: null,
    terminalEnrolled: true,
    switchContext: (...args: unknown[]) => mockSwitchContext(...args),
  })),
}));
jest.mock("@/auth/AuthProvider", () => ({
  useAuth: () => jest.requireMock("@/auth/auth-store").useAuthStore(),
}));
jest.mock("@/api/client", () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}));
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 24 }),
}));
jest.mock("@/components/ui/Icon", () => ({ Icon: () => null }));
jest.mock("@/components/ui/Button", () => ({
  Button: ({
    children,
    onPress,
  }: {
    children: string;
    onPress: () => void;
  }) => {
    const { Pressable, Text } = jest.requireActual("react-native");
    return (
      <Pressable onPress={onPress}>
        <Text>{children}</Text>
      </Pressable>
    );
  },
}));
jest.mock("expo-router", () => {
  const { View, Pressable, Text } = jest.requireActual("react-native");
  const Tabs = ({ children }: { children: React.ReactNode }) => (
    <View>{children}</View>
  );
  Tabs.Screen = function MockTabScreen({
    name,
    listeners,
    options,
  }: {
    name: string;
    listeners: { tabPress?: (event: { preventDefault: () => void }) => void };
    options: { href?: null };
  }) {
    return options.href === null ? null : (
      <Pressable
        onPress={() => listeners.tabPress?.({ preventDefault: jest.fn() })}
      >
        <Text>{name}</Text>
      </Pressable>
    );
  };
  return {
    useRouter: () => mockRouter,
    useRootNavigationState: () => ({ key: mockNavigationKey }),
    usePathname: () => mockPathname,
    useFocusEffect: (callback: () => (() => void) | undefined) =>
      jest.requireActual("react").useEffect(callback, [callback]),
    Stack: View,
    Redirect: ({ href }: { href: string }) => <Text>{href}</Text>,
    Tabs,
  };
});

const original: Session = {
  token: "tenant-token",
  sessionId: "tenant-session",
  user: {
    id: "account-a",
    username: "reza",
    fullName: "Reza",
    role: "superadmin",
    active: true,
    mustChangePassword: false,
  },
  contextKind: "tenant",
  tenantId: "tenant-a",
  dataMode: "sandbox",
  dataSpaceId: "sandbox-a",
  sandboxGeneration: 2,
  establishedAt: "2026-09-14T00:00:00Z",
};
const account: Session = {
  ...original,
  token: "account-token",
  sessionId: "account-session",
  contextKind: "account",
  tenantId: null,
};

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetContextNavigation();
  mockPathname = "/home";
  mockNavigationKey = "root";
  useAuthStore.setState({
    session: original,
    switchingMode: false,
    scopeLocked: false,
    bootError: null,
    terminalEnrolled: true,
  });
  mockSwitchContext.mockImplementation(async (kind, tenantId) => {
    useAuthStore.setState({ switchingMode: true });
    useAuthStore.setState({
      session:
        kind === "account"
          ? account
          : {
              ...original,
              sessionId: "next-tenant-session",
              tenantId,
              dataMode: "production",
            },
    });
    useAuthStore.setState({ switchingMode: false });
  });
  mockApiRequest.mockResolvedValue({
    tenants: [{ tenant: { id: "tenant-a", status: "active" } }],
  });
});

it("opens Pengguna only on explicit tab press and navigates after account exchange", async () => {
  render(<TabsLayout />);
  expect(mockSwitchContext).not.toHaveBeenCalled();
  await act(async () => fireEvent.press(screen.getByText("users")));
  expect(mockSwitchContext).toHaveBeenCalledWith("account");
  expect(useContextNavigationStore.getState()).toMatchObject({
    status: "ready",
    destination: "/management/users",
    destinationSessionId: "account-session",
    previousTenantId: "tenant-a",
  });
  expect(mockReplace).not.toHaveBeenCalled();
});

it("does not expose the Pengguna tab to an Admin", () => {
  useAuthStore.setState({
    session: { ...original, user: { ...original.user, role: "admin" } },
  });
  render(<TabsLayout />);
  expect(screen.queryByText("users")).toBeNull();
});

it("blocks duplicate presses through the exchange and route commit", async () => {
  const waiting = deferred();
  mockSwitchContext.mockImplementationOnce(async () => {
    await waiting.promise;
    useAuthStore.setState({ session: account });
  });
  const first = navigateContext({
    kind: "management",
    path: "/management/users",
  });
  await navigateContext({ kind: "management", path: "/management/tenants" });
  expect(mockSwitchContext).toHaveBeenCalledTimes(1);
  waiting.resolve();
  await first;
  await navigateContext({ kind: "business", tenantId: "tenant-b" });
  expect(mockSwitchContext).toHaveBeenCalledTimes(1);
  expect(useContextNavigationStore.getState().destination).toBe(
    "/management/users",
  );
});

it("continues the selected Sandbox without exchanging or changing its mode", async () => {
  await navigateContext({ kind: "business", tenantId: "tenant-a" });
  expect(mockSwitchContext).not.toHaveBeenCalled();
  expect(useAuthStore.getState().session).toBe(original);
  expect(consumeContextDestination(original)).toBe("/");
});

it("recovers a selected business with a database boot error instead of taking the healthy-session shortcut", async () => {
  useAuthStore.setState({ bootError: "Database belum siap" });
  mockSwitchContext.mockImplementationOnce(async (kind, tenantId) => {
    expect(kind).toBe("tenant");
    expect(tenantId).toBe(original.tenantId);
    useAuthStore.setState({
      session: { ...original, sessionId: "recovered", dataMode: "production" },
      bootError: null,
    });
  });
  await navigateContext({ kind: "business", tenantId: original.tenantId! });
  expect(mockSwitchContext).toHaveBeenCalledTimes(1);
  expect(useContextNavigationStore.getState()).toMatchObject({
    status: "ready",
    destination: "/",
    destinationSessionId: "recovered",
  });
});

it("keeps guards pending until the router commits the matching destination", async () => {
  await navigateContext({ kind: "management", path: "/management/users" });
  const view = render(<ContextNavigationCoordinator />);
  expect(mockReplace).toHaveBeenCalledWith("/management/users");
  expect(useContextNavigationStore.getState().status).toBe("ready");
  view.rerender(<ContextNavigationCoordinator />);
  expect(mockReplace).toHaveBeenCalledTimes(1);
  mockPathname = "/management/users";
  view.rerender(<ContextNavigationCoordinator />);
  expect(useContextNavigationStore.getState().status).toBe("idle");
});

it("waits for a mounted navigator and the exact installed destination session", async () => {
  await navigateContext({ kind: "management", path: "/management/users" });
  mockNavigationKey = undefined;
  const view = render(<ContextNavigationCoordinator />);
  expect(mockReplace).not.toHaveBeenCalled();
  mockNavigationKey = "mounted";
  act(() =>
    useAuthStore.setState({
      session: { ...account, sessionId: "different-session" },
    }),
  );
  view.rerender(<ContextNavigationCoordinator />);
  expect(mockReplace).not.toHaveBeenCalled();
  act(() => useAuthStore.setState({ session: account }));
  expect(mockReplace).toHaveBeenCalledTimes(1);
});

it("persists failure feedback across route remounts without automatic retry", async () => {
  mockSwitchContext.mockRejectedValueOnce(
    new Error(
      "Selesaikan perubahan dan konflik di Pusat Sinkron sebelum berpindah bisnis.",
    ),
  );
  await navigateContext({ kind: "management", path: "/management/users" });
  const first = render(<ContextNavigationFeedback />);
  expect(screen.getByText("Buka Pusat Sinkron")).toBeTruthy();
  expect(screen.getByText(/Selesaikan perubahan dan konflik/)).toBeTruthy();
  first.unmount();
  render(<ContextNavigationFeedback />);
  expect(mockSwitchContext).toHaveBeenCalledTimes(1);
  await act(async () => fireEvent.press(screen.getByText("Coba lagi")));
  expect(mockSwitchContext).toHaveBeenCalledTimes(2);
  expect(useContextNavigationStore.getState().destination).toBe(
    "/management/users",
  );
});

it("offers Pusat Sinkron only for an accessible enrolled tenant", async () => {
  mockSwitchContext.mockRejectedValueOnce(new Error("Koneksi terputus"));
  await navigateContext({ kind: "management", path: "/management/users" });
  render(<ContextNavigationFeedback />);
  fireEvent.press(screen.getByText("Buka Pusat Sinkron"));
  expect(mockPush).toHaveBeenCalledWith("/(app)/sync");
  expect(useContextNavigationStore.getState().status).toBe("idle");
});

it("retries post-exchange failure in the target account context", async () => {
  mockSwitchContext.mockImplementationOnce(async () => {
    useAuthStore.setState({ session: account });
    throw new Error("Penyimpanan belum siap");
  });
  await navigateContext({ kind: "management", path: "/management/users" });
  expect(useContextNavigationStore.getState()).toMatchObject({
    status: "failed",
    failedSessionId: account.sessionId,
  });
  render(<ContextNavigationFeedback />);
  expect(screen.queryByText("Buka Pusat Sinkron")).toBeNull();
  await act(async () => retryContextNavigation());
  expect(mockSwitchContext.mock.calls).toEqual([["account"], ["account"]]);
});

it("returns from management to the previous authorized business in Production", async () => {
  await navigateContext({ kind: "management", path: "/management/users" });
  consumeContextDestination(account);
  await navigateContext({ kind: "return" });
  expect(mockApiRequest).toHaveBeenCalledWith("/auth/contexts", {
    token: account.token,
  });
  expect(mockSwitchContext).toHaveBeenLastCalledWith("tenant", "tenant-a");
  expect(useAuthStore.getState().session?.dataMode).toBe("production");
  expect(useContextNavigationStore.getState().destination).toBe("/");
});

it("returns to the chooser when the previous business is no longer authorized", async () => {
  await navigateContext({ kind: "management", path: "/management/users" });
  consumeContextDestination(account);
  mockApiRequest.mockResolvedValue({
    tenants: [{ tenant: { id: "tenant-a", status: "suspended" } }],
  });
  await navigateContext({ kind: "return" });
  expect(mockSwitchContext).toHaveBeenCalledTimes(1);
  expect(useContextNavigationStore.getState().destination).toBe("/contexts");
});

it("does not invent a previous business when management starts from account context", async () => {
  useAuthStore.setState({ session: account });
  await navigateContext({ kind: "return" });
  expect(mockApiRequest).not.toHaveBeenCalled();
  expect(mockSwitchContext).not.toHaveBeenCalled();
  expect(useContextNavigationStore.getState().destination).toBe("/contexts");
});

it("discards failure retry evidence after a new login even for the same account", async () => {
  mockSwitchContext.mockRejectedValueOnce(new Error("Offline"));
  await navigateContext({ kind: "management", path: "/management/users" });
  useAuthStore.setState({ session: { ...original, sessionId: "new-login" } });
  await retryContextNavigation();
  expect(mockSwitchContext).toHaveBeenCalledTimes(1);
  expect(useContextNavigationStore.getState().status).toBe("idle");
});

it("invalidates stale promises synchronously on batched logout and same-account login", async () => {
  render(<ContextNavigationLifecycle />);
  const waiting = deferred();
  mockSwitchContext.mockReturnValueOnce(waiting.promise);
  let pending!: Promise<void>;
  act(() => {
    pending = navigateContext({
      kind: "management",
      path: "/management/users",
    });
  });
  act(() => {
    useAuthStore.setState({ session: null });
    useAuthStore.setState({ session: original });
  });
  await act(async () => {
    waiting.reject(new Error("Old operation failed"));
    await pending;
  });
  expect(useContextNavigationStore.getState()).toMatchObject({
    ownerId: null,
    status: "idle",
    error: null,
  });
});

it("does not let an old account's completion erase a newer navigation intent", async () => {
  const waiting = deferred();
  mockSwitchContext.mockReturnValueOnce(waiting.promise);
  const pending = navigateContext({
    kind: "management",
    path: "/management/users",
  });
  resetContextNavigation();
  const other = {
    ...account,
    sessionId: "other-session",
    user: { ...account.user, id: "account-b" },
  };
  useAuthStore.setState({ session: other });
  await navigateContext({ kind: "management", path: "/management/tenants" });
  waiting.resolve();
  await pending;
  expect(useContextNavigationStore.getState()).toMatchObject({
    ownerId: "account-b",
    status: "ready",
    destination: "/management/tenants",
  });
});

it("preserves legitimate exchanged-session navigation while lifecycle is mounted", async () => {
  render(<ContextNavigationLifecycle />);
  await act(async () =>
    navigateContext({ kind: "management", path: "/management/users" }),
  );
  expect(useContextNavigationStore.getState().status).toBe("ready");
});

it("refuses stale-account or stale-session destination consumption", () => {
  const id = beginContextNavigation(original, {
    kind: "business",
    tenantId: "tenant-a",
  })!;
  completeContextNavigation(id, original, "/");
  expect(
    consumeContextDestination({ ...original, sessionId: "stale" }),
  ).toBeNull();
  expect(
    consumeContextDestination({
      ...original,
      user: { ...original.user, id: "other" },
    }),
  ).toBeNull();
  expect(useContextNavigationStore.getState().status).toBe("ready");
});

it.each(["/management/users", "/management/tenants", "/management/audit"])(
  "handles Android Back from management root %s through the safe return action",
  async (path) => {
    await navigateContext({ kind: "management", path: "/management/users" });
    consumeContextDestination(account);
    mockPathname = path;
    const remove = jest.fn();
    const listen = jest
      .spyOn(BackHandler, "addEventListener")
      .mockReturnValue({ remove });
    const view = render(<ManagementLayout />);
    const callback = listen.mock.calls.find(
      ([event]) => event === "hardwareBackPress",
    )![1];
    await act(async () => {
      expect((callback as () => boolean)()).toBe(true);
    });
    expect(mockSwitchContext).toHaveBeenLastCalledWith("tenant", "tenant-a");
    view.unmount();
    expect(remove).toHaveBeenCalled();
    listen.mockRestore();
  },
);

it("lets nested management editors use normal Android Back within management", () => {
  useAuthStore.setState({ session: account });
  mockPathname = "/management/users/staff-id";
  const listen = jest.spyOn(BackHandler, "addEventListener");
  render(<ManagementLayout />);
  expect(listen).not.toHaveBeenCalled();
  expect(mockSwitchContext).not.toHaveBeenCalled();
  listen.mockRestore();
});
