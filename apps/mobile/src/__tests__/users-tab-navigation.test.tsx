import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { BackHandler } from "react-native";

import UsersTabScreen from "@/app/(app)/(tabs)/users";
import ProtectedLayout from "@/app/(app)/_layout";
import { useAuthStore } from "@/auth/auth-store";
import type { Session } from "@/domain/types";
import {
  resetContextNavigation,
  useContextNavigationStore,
} from "@/navigation/context-navigation-store";

const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockSetParams = jest.fn();
const mockReturnToBusiness = jest.fn();
const mockRouter = {
  push: mockPush,
  replace: mockReplace,
  setParams: mockSetParams,
};
let mockParams: { userId?: string; create?: string } = {};
let mockSegments = ["(app)", "(tabs)", "users"];
let mockBusy = false;
let mockCreateDone: (() => void) | undefined;

jest.mock("@/auth/auth-store", () => ({
  useAuthStore: jest.requireActual("zustand").create(() => ({
    session: null,
    booting: false,
    bootError: null,
    terminalEnrolled: false,
    scopeLocked: false,
  })),
}));
jest.mock("@/auth/AuthProvider", () => ({
  useAuth: () => jest.requireMock("@/auth/auth-store").useAuthStore(),
}));
jest.mock("@/navigation/context-navigation", () => ({
  useContextNavigation: () => ({
    busy: mockBusy,
    returnToBusiness: mockReturnToBusiness,
  }),
}));
jest.mock("expo-router", () => {
  const { Text } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    useRouter: () => mockRouter,
    useLocalSearchParams: () => mockParams,
    useSegments: () => mockSegments,
    useFocusEffect: (callback: () => (() => void) | undefined) =>
      jest.requireActual("react").useEffect(callback, [callback]),
    Stack: () => <Text>Protected stack</Text>,
    Redirect: ({ href }: { href: string }) => <Text>{href}</Text>,
  };
});
// Keep the routing contract independent of API requests and form styling.
// Real directory/create/editor behavior is covered in user-screen-errors.test.
jest.mock("@/tenant/screens", () => {
  const { Pressable, Text, View } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    ManagementEntryScreen: () => <Text>Safe management entry</Text>,
    ManagedUsersScreen: ({
      onCreate,
      onOpenUser,
    }: {
      onCreate: () => void;
      onOpenUser: (id: string) => void;
    }) => (
      <View>
        <Text>Staff directory</Text>
        <Pressable onPress={onCreate}>
          <Text>Create staff</Text>
        </Pressable>
        <Pressable onPress={() => onOpenUser("staff-1")}>
          <Text>Open first staff account</Text>
        </Pressable>
      </View>
    ),
    ManagedUserCreateScreen: ({
      onDone,
      onCancel,
    }: {
      onDone: () => void;
      onCancel: () => void;
    }) => {
      mockCreateDone = onDone;
      return (
        <View>
          <Text>Create staff form</Text>
          <Pressable onPress={onDone}>
            <Text>Finish creation</Text>
          </Pressable>
          <Pressable onPress={onCancel}>
            <Text>Cancel creation</Text>
          </Pressable>
        </View>
      );
    },
    ManagedUserEditor: ({ id, onBack }: { id: string; onBack: () => void }) => (
      <View>
        <Text>{`Editing ${id}`}</Text>
        <Pressable onPress={onBack}>
          <Text>Back to staff</Text>
        </Pressable>
      </View>
    ),
  };
});

const accountSession: Session = {
  token: "account-token",
  sessionId: "account-session",
  contextKind: "account",
  tenantId: null,
  dataMode: "production",
  dataSpaceId: "",
  sandboxGeneration: null,
  establishedAt: "2026-09-15T00:00:00Z",
  user: {
    id: "superadmin-1",
    username: "superadmin",
    fullName: "Superadmin",
    role: "superadmin",
    active: true,
    mustChangePassword: false,
  },
};
const tenantSession: Session = {
  ...accountSession,
  token: "tenant-token",
  sessionId: "tenant-session",
  contextKind: "tenant",
  tenantId: "tenant-1",
  dataSpaceId: "production-1",
};
const backListeners = new Set<
  Parameters<typeof BackHandler.addEventListener>[1]
>();

beforeEach(() => {
  jest.clearAllMocks();
  resetContextNavigation();
  mockParams = {};
  mockSegments = ["(app)", "(tabs)", "users"];
  mockBusy = false;
  mockCreateDone = undefined;
  mockReturnToBusiness.mockResolvedValue(undefined);
  backListeners.clear();
  jest
    .spyOn(BackHandler, "addEventListener")
    .mockImplementation((_, listener) => {
      backListeners.add(listener);
      return {
        remove: () => {
          backListeners.delete(listener);
        },
      };
    });
  useAuthStore.setState({
    session: accountSession,
    booting: false,
    bootError: null,
    terminalEnrolled: false,
    scopeLocked: false,
  });
});

afterEach(() => jest.restoreAllMocks());

function pressAndroidBack() {
  expect(backListeners.size).toBe(1);
  act(() => {
    expect(
      [...backListeners][0]!({ type: "hardwareBackPress", timeStamp: 1 }),
    ).toBe(true);
  });
}

function expectNoManagementRouteNavigation() {
  expect(mockPush).not.toHaveBeenCalled();
  expect(mockReplace).not.toHaveBeenCalled();
}

it("keeps staff directory, creation, and editing inside the Pengguna tab", () => {
  render(<UsersTabScreen />);
  expect(screen.getByText("Staff directory")).toBeTruthy();
  fireEvent.press(screen.getByText("Create staff"));
  expect(screen.getByText("Create staff form")).toBeTruthy();
  fireEvent.press(screen.getByText("Finish creation"));
  fireEvent.press(screen.getByText("Open first staff account"));
  expect(screen.getByText("Editing staff-1")).toBeTruthy();
  fireEvent.press(screen.getByText("Back to staff"));
  expect(screen.getByText("Staff directory")).toBeTruthy();
  expectNoManagementRouteNavigation();
  expect(mockReturnToBusiness).not.toHaveBeenCalled();
});

it.each(["Create staff", "Open first staff account"])(
  "Android Back from %s returns to the directory without exchanging context",
  (entry) => {
    render(<UsersTabScreen />);
    fireEvent.press(screen.getByText(entry));
    pressAndroidBack();
    expect(screen.getByText("Staff directory")).toBeTruthy();
    expect(mockReturnToBusiness).not.toHaveBeenCalled();
    expect(mockReturnToBusiness).not.toHaveBeenCalled();
    expectNoManagementRouteNavigation();
  },
);

it("lets Android handle Back from the directory without a context exchange", () => {
  render(<UsersTabScreen />);
  expect(backListeners.size).toBe(1);
  expect(
    [...backListeners][0]!({ type: "hardwareBackPress", timeStamp: 1 }),
  ).toBe(false);
  expect(mockReturnToBusiness).not.toHaveBeenCalled();
  expect(screen.getByText("Staff directory")).toBeTruthy();
});

it("removes its Android Back listener when the tab unmounts", () => {
  const view = render(<UsersTabScreen />);
  expect(backListeners.size).toBe(1);
  view.unmount();
  expect(backListeners.size).toBe(0);
});

it("clears editor state when the authenticated session changes", () => {
  render(<UsersTabScreen />);
  fireEvent.press(screen.getByText("Open first staff account"));
  act(() =>
    useAuthStore.setState({
      session: {
        ...accountSession,
        token: "next-token",
        sessionId: "next-session",
      },
    }),
  );
  expect(screen.queryByText("Editing staff-1")).toBeNull();
  expect(screen.getByText("Staff directory")).toBeTruthy();
  expect(backListeners.size).toBe(1);
});

it.each(["account", "tenant", "logout"])(
  "ignores a late creation completion after switching to another %s context",
  (target) => {
    render(<UsersTabScreen />);
    fireEvent.press(screen.getByText("Create staff"));
    const finishOldRequest = mockCreateDone!;
    act(() =>
      useAuthStore.setState({
        session:
          target === "logout"
            ? null
            : target === "tenant"
              ? tenantSession
              : {
                  ...accountSession,
                  token: "other-token",
                  sessionId: "other-session",
                },
      }),
    );
    act(() => finishOldRequest());
    expect(mockSetParams).not.toHaveBeenCalled();
    expectNoManagementRouteNavigation();
    expect(screen.queryByText("Create staff form")).toBeNull();
  },
);

it("ignores creation completion after cancellation and opening another staff account", () => {
  render(<UsersTabScreen />);
  fireEvent.press(screen.getByText("Create staff"));
  const finishOldRequest = mockCreateDone!;
  fireEvent.press(screen.getByText("Cancel creation"));
  fireEvent.press(screen.getByText("Open first staff account"));
  mockSetParams.mockClear();
  act(() => finishOldRequest());
  expect(screen.getByText("Editing staff-1")).toBeTruthy();
  expect(mockSetParams).not.toHaveBeenCalled();
  expectNoManagementRouteNavigation();
});

it("ignores an earlier cancelled create even while a fresh create pane is open", () => {
  render(<UsersTabScreen />);
  fireEvent.press(screen.getByText("Create staff"));
  const finishOldRequest = mockCreateDone!;
  fireEvent.press(screen.getByText("Cancel creation"));
  fireEvent.press(screen.getByText("Create staff"));
  mockSetParams.mockClear();
  act(() => finishOldRequest());
  expect(screen.getByText("Create staff form")).toBeTruthy();
  expect(mockSetParams).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText("Finish creation"));
  expect(screen.getByText("Staff directory")).toBeTruthy();
});

it("opens compatibility alias parameters within the same tab", () => {
  mockParams = { userId: "legacy-staff" };
  const view = render(<UsersTabScreen />);
  expect(screen.getByText("Editing legacy-staff")).toBeTruthy();
  mockParams = { create: "true" };
  view.rerender(<UsersTabScreen />);
  expect(screen.getByText("Create staff form")).toBeTruthy();
  expectNoManagementRouteNavigation();
});

it("mounts staff management directly from the active tenant session", () => {
  useAuthStore.setState({ session: tenantSession, terminalEnrolled: true });
  render(<UsersTabScreen />);
  expect(screen.getByText("Staff directory")).toBeTruthy();
  expect(screen.queryByText("Safe management entry")).toBeNull();
});

it("denies staff management to Admin accounts and signed-out users", () => {
  useAuthStore.setState({
    session: {
      ...accountSession,
      user: { ...accountSession.user, role: "admin" },
    },
  });
  const view = render(<UsersTabScreen />);
  expect(screen.getByText("/")).toBeTruthy();
  act(() => useAuthStore.setState({ session: null }));
  view.rerender(<UsersTabScreen />);
  expect(screen.getByText("/(auth)/login")).toBeTruthy();
  expect(screen.queryByText("Staff directory")).toBeNull();
});

describe("ProtectedLayout account-context exception", () => {
  it("allows only the Superadmin users tab without a tenant, data space, or terminal enrollment", () => {
    render(<ProtectedLayout />);
    expect(screen.getByText("Protected stack")).toBeTruthy();
    expect(screen.queryByText("/(auth)/terminal-enrollment")).toBeNull();
    expect(useAuthStore.getState()).toMatchObject({
      session: { contextKind: "account", tenantId: null, dataSpaceId: "" },
      terminalEnrolled: false,
    });
  });

  it.each(["home", "sell", "history", "settings"])(
    "rejects account-context access to the %s business tab",
    (route) => {
      mockSegments = ["(app)", "(tabs)", route];
      render(<ProtectedLayout />);
      expect(screen.getByText("/contexts")).toBeTruthy();
      expect(screen.queryByText("Protected stack")).toBeNull();
    },
  );

  it("does not mistake a non-tab users segment for the account exception", () => {
    mockSegments = ["(app)", "users"];
    render(<ProtectedLayout />);
    expect(screen.getByText("/contexts")).toBeTruthy();
  });

  it("does not allow an account-context Admin to bypass guards via the users URL", () => {
    useAuthStore.setState({
      session: {
        ...accountSession,
        user: { ...accountSession.user, role: "admin" },
      },
    });
    render(<ProtectedLayout />);
    expect(screen.getByText("/contexts")).toBeTruthy();
  });

  it("still requires tenant enrollment for the same users route in tenant context", () => {
    useAuthStore.setState({ session: tenantSession });
    const view = render(<ProtectedLayout />);
    expect(screen.getByText("/(auth)/terminal-enrollment")).toBeTruthy();
    act(() => useAuthStore.setState({ terminalEnrolled: true }));
    view.rerender(<ProtectedLayout />);
    expect(screen.getByText("Protected stack")).toBeTruthy();
  });

  it("preserves scope lock and forced-password protections for account management", () => {
    useAuthStore.setState({ scopeLocked: true });
    const view = render(<ProtectedLayout />);
    expect(screen.getByText("/contexts")).toBeTruthy();
    act(() =>
      useAuthStore.setState({
        scopeLocked: false,
        session: {
          ...accountSession,
          user: { ...accountSession.user, mustChangePassword: true },
        },
      }),
    );
    view.rerender(<ProtectedLayout />);
    expect(screen.getByText("/(auth)/change-password")).toBeTruthy();
  });

  it.each(["running", "ready"] as const)(
    "does not mount the users stack while a context transition is %s",
    (status) => {
      useContextNavigationStore.setState({ status });
      render(<ProtectedLayout />);
      expect(screen.queryByText("Protected stack")).toBeNull();
      expect(screen.queryByText("/contexts")).toBeNull();
    },
  );

  it("does not bypass hydration, storage failure, or login guards", () => {
    useAuthStore.setState({ booting: true });
    const view = render(<ProtectedLayout />);
    expect(screen.queryByText("Protected stack")).toBeNull();
    act(() =>
      useAuthStore.setState({ booting: false, bootError: "Storage failed" }),
    );
    view.rerender(<ProtectedLayout />);
    expect(screen.getByText("Database tidak dapat dibuka")).toBeTruthy();
    act(() => useAuthStore.setState({ bootError: null, session: null }));
    view.rerender(<ProtectedLayout />);
    expect(screen.getByText("/(auth)/login")).toBeTruthy();
  });
});
