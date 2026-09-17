import {
  act,
  fireEvent,
  render as renderScreen,
  waitFor,
} from "@testing-library/react-native";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";

import { createQueryClient } from "@/api/query-client";
import {
  ManagedUsersScreen as UsersScreen,
  ManagedUserEditor,
  ManagedUserCreateScreen,
  ManagedTenantsScreen,
  managedPasswordError,
  managedUsernameError,
} from "@/tenant/screens";
import type { Session, UserSummary } from "@/domain/types";
import { SERVER_UNREACHABLE_MESSAGE } from "@/utils/errors";

function render(element: ReactElement) {
  const queryClient = createQueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderScreen(
    <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>,
  );
}

const mockApiRequest = jest.fn();
const mockRouterPush = jest.fn();
const mockRouterBack = jest.fn();
const mockRouterReplace = jest.fn();
const mockReturnToBusiness = jest.fn();
const mockConfirm = jest.fn();

function resetManagementMocks() {
  // Preserve React Native's native-component registry implementations. Switch
  // loads its generated view lazily, after beforeEach; resetAllMocks clears the
  // preset's registry factories and turns that native boundary into undefined.
  jest.clearAllMocks();
  mockSession = accountSession;
  [
    mockApiRequest,
    mockRouterPush,
    mockRouterBack,
    mockRouterReplace,
    mockReturnToBusiness,
    mockConfirm,
  ].forEach((mock) => mock.mockReset());
}

jest.mock("@/navigation/context-navigation", () => ({
  useContextNavigation: () => ({
    busy: false,
    returnToBusiness: mockReturnToBusiness,
  }),
}));

jest.mock("@/components/ui/ConfirmationProvider", () => ({
  useConfirmation: () => ({ confirm: mockConfirm }),
}));

jest.mock("@/tenant/configuration", () => ({
  cacheTenantConfiguration: jest.fn(),
}));

const sessionUser: UserSummary = {
  id: "USER-1",
  fullName: "Super Admin",
  username: "superadmin",
  role: "superadmin",
  active: true,
  mustChangePassword: false,
};

const loadedUser: UserSummary = {
  id: "USER-2",
  fullName: "Admin Toko",
  username: "admin.toko",
  role: "admin",
  active: true,
  mustChangePassword: false,
};

const accountSession: Session = {
  token: "session-token",
  sessionId: "account-session",
  contextKind: "account",
  tenantId: null,
  dataMode: "production",
  dataSpaceId: null,
  sandboxGeneration: null,
  establishedAt: "2026-09-16T00:00:00Z",
  user: sessionUser,
};

const selectedBusinessSession: Session = {
  ...accountSession,
  token: "tenant-token",
  sessionId: "tenant-session",
  contextKind: "tenant",
  tenantId: "tenant-a",
  dataSpaceId: "production-a",
};

const retiredPlatformSession: Session = {
  ...accountSession,
  token: "platform-token",
  sessionId: "platform-session",
  contextKind: "platform",
};

let mockSession: Session | null = accountSession;

jest.mock("@/api/client", () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}));

jest.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({ session: mockSession }),
}));

jest.mock("expo-router", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { Text } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    useRouter: () => ({
      push: mockRouterPush,
      back: mockRouterBack,
      replace: mockRouterReplace,
    }),
    Redirect: ({ href }: { href: string | { pathname: string } }) => (
      <Text>{typeof href === "string" ? href : href.pathname}</Text>
    ),
    useLocalSearchParams: () => ({ id: loadedUser.id }),
    useFocusEffect: (effect: () => void | (() => void)) =>
      React.useEffect(effect, [effect]),
  };
});

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
  const { Text, View } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    PageHeader: ({ title, right }: { title: string; right?: ReactNode }) => (
      <View>
        <Text>{title}</Text>
        {right}
      </View>
    ),
  };
});

jest.mock("@/components/ui/Icon", () => ({ Icon: () => null }));

jest.mock("@/components/ui/Card", () => {
  const { View } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    Card: ({ children }: { children: ReactNode }) => <View>{children}</View>,
  };
});

jest.mock("@/components/ui/Field", () => {
  const { TextInput, Text, View } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    Field: ({
      label,
      error,
      ...props
    }: import("react-native").TextInputProps & {
      label: string;
      error?: string;
    }) => (
      <View>
        <TextInput accessibilityLabel={label} {...props} />
        {error ? <Text>{error}</Text> : null}
      </View>
    ),
  };
});

jest.mock("@/components/ui/Button", () => {
  const { Pressable, Text } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    Button: ({
      children,
      onPress,
      disabled,
      loading,
      accessibilityLabel,
      accessibilityState,
    }: {
      children: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
      loading?: boolean;
      accessibilityLabel?: string;
      accessibilityState?: import("react-native").AccessibilityState;
    }) => (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{
          ...accessibilityState,
          disabled: disabled || loading,
        }}
        disabled={disabled || loading}
        onPress={onPress}
      >
        <Text>{children}</Text>
      </Pressable>
    ),
  };
});

jest.mock("@/components/ui/StateView", () => {
  const { Pressable, Text, View } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    StateView: ({
      actionLabel,
      message,
      onAction,
      title,
    }: {
      actionLabel?: string;
      message: string;
      onAction?: () => void;
      title: string;
    }) => (
      <View>
        <Text>{title}</Text>
        <Text>{message}</Text>
        {actionLabel && onAction ? (
          <Pressable accessibilityRole="button" onPress={onAction}>
            <Text>{actionLabel}</Text>
          </Pressable>
        ) : null}
      </View>
    ),
  };
});

jest.mock("@/components/forms/UserForm", () => {
  const { Text } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    UserForm: ({ initial }: { initial: UserSummary }) => (
      <Text>{initial.fullName}</Text>
    ),
  };
});

const nativeConnectionError = new Error(
  "fetch failed: java.net.ConnectException: Failed to connect to /192.168.18.254:8080",
);

describe("user screen connection errors", () => {
  beforeEach(() => {
    resetManagementMocks();
  });

  it("shows an understandable list error and retries", async () => {
    mockApiRequest
      .mockRejectedValueOnce(nativeConnectionError)
      .mockResolvedValueOnce([loadedUser]);
    const screen = render(<UsersScreen />);

    await waitFor(() => {
      expect(screen.getByText(SERVER_UNREACHABLE_MESSAGE)).toBeTruthy();
    });
    expect(screen.queryByText(nativeConnectionError.message)).toBeNull();

    fireEvent.press(
      screen.getByRole("button", { name: "Muat ulang pengguna" }),
    );

    await waitFor(() => {
      expect(screen.getByText(loadedUser.fullName)).toBeTruthy();
      expect(screen.queryByText(SERVER_UNREACHABLE_MESSAGE)).toBeNull();
    });
  });

  it("shows an understandable edit error and retries", async () => {
    mockApiRequest
      .mockRejectedValueOnce(nativeConnectionError)
      .mockResolvedValueOnce(loadedUser);
    const screen = render(<ManagedUserEditor id={loadedUser.id} />);

    await waitFor(() => {
      expect(screen.getByText(SERVER_UNREACHABLE_MESSAGE)).toBeTruthy();
    });
    expect(screen.queryByText(nativeConnectionError.message)).toBeNull();

    fireEvent.press(screen.getByRole("button", { name: "Muat ulang akun" }));

    await waitFor(() => {
      expect(screen.getByText(loadedUser.fullName)).toBeTruthy();
      expect(screen.queryByText(SERVER_UNREACHABLE_MESSAGE)).toBeNull();
    });
  });
});

describe("management directory and account forms", () => {
  beforeEach(resetManagementMocks);

  it("shows loading, searchable staff, no results, and direct account actions without tenant shortcuts", async () => {
    let resolve!: (users: UserSummary[]) => void;
    mockApiRequest.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const screen = render(<UsersScreen />);
    expect(screen.getByText("Memuat daftar pengguna…")).toBeTruthy();
    await act(async () => resolve([loadedUser, sessionUser]));
    await waitFor(() =>
      expect(screen.queryByText("Memuat daftar pengguna…")).toBeNull(),
    );
    expect(screen.queryByRole("button", { name: "Kelola tenant" })).toBeNull();
    fireEvent.changeText(screen.getByLabelText("Cari pengguna"), "ADMIN.TOKO");
    expect(screen.getByText(loadedUser.fullName)).toBeTruthy();
    expect(screen.queryByText(sessionUser.fullName)).toBeNull();
    fireEvent.changeText(
      screen.getByLabelText("Cari pengguna"),
      "does not exist",
    );
    expect(
      screen.getByText("Tidak ada pengguna yang cocok dengan pencarian."),
    ).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: "Hapus pencarian" }));
    fireEvent.press(
      screen.getByRole("button", {
        name: `Kelola akun ${loadedUser.fullName}. Admin. Aktif`,
      }),
    );
    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: "/users",
      params: { userId: loadedUser.id },
    });
    expect(
      screen.queryByRole("button", { name: "Kembali ke bisnis" }),
    ).toBeNull();
  });

  it("distinguishes an empty directory from no matching search results", async () => {
    mockApiRequest.mockResolvedValueOnce([]);
    const screen = render(<UsersScreen />);
    await waitFor(() =>
      expect(
        screen.getByText("Belum ada pengguna. Tambahkan akun untuk staf."),
      ).toBeTruthy(),
    );
    expect(
      screen.queryByText("Tidak ada pengguna yang cocok dengan pencarian."),
    ).toBeNull();
    expect(
      screen.getAllByRole("button", { name: "Tambah pengguna" }),
    ).toHaveLength(1);
  });

  it("matches account username and UTF-8 password limits", () => {
    expect(managedUsernameError(" ADMIN.TOKO ")).toBeUndefined();
    expect(managedUsernameError("ab")).toBeTruthy();
    expect(managedUsernameError(".admin")).toBeTruthy();
    expect(managedUsernameError("a".repeat(65))).toBeTruthy();
    expect(managedPasswordError("12345678901")).toBeTruthy();
    expect(managedPasswordError("123456789012")).toBeUndefined();
    expect(managedPasswordError("é".repeat(128))).toBeUndefined();
    expect(managedPasswordError("é".repeat(129))).toBeTruthy();
  });

  it("starts with Admin and submits a validated normalized account once", async () => {
    mockApiRequest.mockResolvedValueOnce(loadedUser);
    const screen = render(<ManagedUserCreateScreen />);
    const create = screen.getByRole("button", { name: "Buat akun" });
    expect(create).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Admin" }).props.accessibilityState
        .selected,
    ).toBe(true);
    fireEvent.changeText(screen.getByLabelText("Nama lengkap"), " Kasir Baru ");
    fireEvent.changeText(
      screen.getByLabelText("Nama pengguna"),
      " ADMIN.BARU ",
    );
    fireEvent.changeText(
      screen.getByLabelText("Kata sandi sementara"),
      "short",
    );
    expect(create).toBeDisabled();
    fireEvent.changeText(
      screen.getByLabelText("Kata sandi sementara"),
      "temporary-password",
    );
    fireEvent.press(create);
    await waitFor(() =>
      expect(mockRouterReplace).toHaveBeenCalledWith("/users"),
    );
    expect(mockApiRequest).toHaveBeenCalledTimes(1);
    expect(mockApiRequest).toHaveBeenCalledWith("/management/users", {
      method: "POST",
      token: "session-token",
      body: {
        fullName: "Kasir Baru",
        username: "admin.baru",
        role: "admin",
        temporaryPassword: "temporary-password",
      },
    });
  });

  it("cancels account creation without a request", () => {
    const screen = render(<ManagedUserCreateScreen />);
    fireEvent.changeText(
      screen.getByLabelText("Kata sandi sementara"),
      "temporary-password",
    );
    fireEvent.press(screen.getByRole("button", { name: "Batal" }));
    expect(mockRouterBack).toHaveBeenCalledTimes(1);
    expect(mockApiRequest).not.toHaveBeenCalled();
  });

  it("separates role/status editing from password reset and waits for confirmation", async () => {
    mockApiRequest.mockResolvedValue(loadedUser);
    const screen = render(<ManagedUserEditor id={loadedUser.id} />);
    await waitFor(() =>
      expect(screen.getByText("Akses pengguna")).toBeTruthy(),
    );
    expect(screen.getByText("Pemulihan kata sandi")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Simpan akses akun" }),
    ).toBeDisabled();
    fireEvent(screen.getByLabelText("Akun aktif"), "valueChange", false);
    fireEvent.press(screen.getByRole("button", { name: "Simpan akses akun" }));
    expect(mockConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Simpan akses akun?",
        destructive: true,
      }),
    );
    expect(mockApiRequest).toHaveBeenCalledTimes(1);
    await act(async () => {
      await mockConfirm.mock.calls[0][0].onConfirm();
    });
    expect(mockApiRequest).toHaveBeenCalledWith(
      `/management/users/${loadedUser.id}`,
      expect.objectContaining({
        method: "PATCH",
        body: { role: "admin", active: false },
      }),
    );
    expect(
      screen.getByRole("button", { name: "Reset kata sandi" }),
    ).toBeDisabled();
    fireEvent.changeText(
      screen.getByLabelText("Kata sandi sementara baru"),
      "temporary-password",
    );
    fireEvent.press(screen.getByRole("button", { name: "Reset kata sandi" }));
    expect(mockConfirm).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: "Reset kata sandi?",
        destructive: true,
      }),
    );
    await act(async () => {
      await mockConfirm.mock.calls[1][0].onConfirm();
    });
    expect(mockApiRequest).toHaveBeenCalledWith(
      `/management/users/${loadedUser.id}/reset-password`,
      expect.objectContaining({
        method: "POST",
        body: { temporaryPassword: "temporary-password" },
      }),
    );
    expect(screen.getByLabelText("Kata sandi sementara baru").props.value).toBe(
      "",
    );
  });

  it("protects self-demotion, self-deactivation, and self-reset", async () => {
    mockApiRequest.mockResolvedValueOnce(sessionUser);
    const screen = render(<ManagedUserEditor id={sessionUser.id} />);
    await waitFor(() =>
      expect(screen.getByText(sessionUser.fullName)).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: "Admin" })).toBeDisabled();
    expect(screen.getByLabelText("Akun aktif").props.disabled).toBe(true);
    expect(
      screen.queryByRole("button", { name: "Simpan akses akun" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Reset kata sandi" }),
    ).toBeNull();
  });
});

describe("tenant management", () => {
  const tenants = [
    {
      id: "tenant-a",
      name: "Bisnis A",
      slug: "bisnis-a",
      status: "active",
      revision: 1,
    },
    {
      id: "tenant-b",
      name: "Bisnis B",
      slug: "bisnis-b",
      status: "pending_setup",
      revision: 1,
    },
  ];
  beforeEach(() => {
    resetManagementMocks();
    mockApiRequest.mockImplementation((path: string) =>
      Promise.resolve(
        path === "/auth/contexts"
          ? { tenantProvisioningEnabled: true }
          : tenants,
      ),
    );
  });

  it("lists businesses first and shows only one editor or creation form", async () => {
    const screen = render(<ManagedTenantsScreen />);
    await waitFor(() => expect(screen.getByText("Bisnis A")).toBeTruthy());
    expect(screen.queryByLabelText("Nama bisnis")).toBeNull();
    fireEvent.press(
      screen.getByRole("button", { name: "Kelola bisnis Bisnis A. Aktif" }),
    );
    expect(screen.getByLabelText("Nama pengelolaan bisnis").props.value).toBe(
      "Bisnis A",
    );
    fireEvent.press(
      screen.getByRole("button", {
        name: "Kelola bisnis Bisnis B. Menunggu aktivasi",
      }),
    );
    expect(screen.getAllByLabelText("Nama pengelolaan bisnis")).toHaveLength(1);
    expect(screen.getByLabelText("Nama pengelolaan bisnis").props.value).toBe(
      "Bisnis B",
    );
    fireEvent.press(screen.getByRole("button", { name: "Tambah bisnis" }));
    expect(screen.queryByLabelText("Nama pengelolaan bisnis")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Buat bisnis aktif" }),
    ).toBeDisabled();
    fireEvent.changeText(screen.getByLabelText("Nama bisnis"), "New tenant");
    fireEvent.changeText(screen.getByLabelText("Kode bisnis"), "valid-code");
    expect(
      screen.getByRole("button", { name: "Buat bisnis aktif" }),
    ).not.toBeDisabled();
    fireEvent.press(screen.getByRole("button", { name: "Batal" }));
    expect(
      mockApiRequest.mock.calls.every(([, options]) => !options?.method),
    ).toBe(true);
  });

  it("confirms suspension and preserves existing tenant management when provisioning is disabled", async () => {
    mockApiRequest.mockImplementation((path: string) =>
      Promise.resolve(
        path === "/auth/contexts"
          ? { tenantProvisioningEnabled: false }
          : tenants,
      ),
    );
    const screen = render(<ManagedTenantsScreen />);
    await waitFor(() => expect(screen.getByText("Bisnis A")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Tambah bisnis" })).toBeNull();
    fireEvent.press(
      screen.getByRole("button", { name: "Kelola bisnis Bisnis A. Aktif" }),
    );
    fireEvent.press(screen.getByRole("button", { name: "Tangguhkan bisnis" }));
    expect(mockConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        destructive: true,
        title: "Tangguhkan bisnis?",
      }),
    );
    expect(
      mockApiRequest.mock.calls.every(([, options]) => !options?.method),
    ).toBe(true);
    await act(async () => {
      await mockConfirm.mock.calls[0][0].onConfirm();
    });
    expect(mockApiRequest).toHaveBeenCalledWith(
      "/management/tenants/tenant-a/status",
      expect.objectContaining({
        method: "POST",
        body: { status: "suspended" },
      }),
    );
  });
});

describe("selected-business organization management", () => {
  beforeEach(() => {
    resetManagementMocks();
    mockSession = selectedBusinessSession;
    mockApiRequest.mockResolvedValue([loadedUser]);
  });

  it("loads the Pengguna directory from the active business session", async () => {
    const screen = render(<UsersScreen />);
    await waitFor(() => expect(screen.getByText("Admin Toko")).toBeTruthy());
    expect(screen.queryByText("/contexts")).toBeNull();
    expect(mockApiRequest).toHaveBeenCalledWith(
      "/management/users",
      expect.objectContaining({ token: "tenant-token" }),
    );
  });

  it("creates and edits accounts from the active business session", async () => {
    const create = render(<ManagedUserCreateScreen />);
    fireEvent.changeText(create.getByLabelText("Nama lengkap"), "Kasir Baru");
    fireEvent.changeText(create.getByLabelText("Nama pengguna"), "admin.baru");
    fireEvent.changeText(
      create.getByLabelText("Kata sandi sementara"),
      "temporary-password",
    );
    fireEvent.press(create.getByRole("button", { name: "Buat akun" }));
    await waitFor(() =>
      expect(mockRouterReplace).toHaveBeenCalledWith("/users"),
    );
    expect(mockApiRequest).toHaveBeenCalledWith(
      "/management/users",
      expect.objectContaining({ method: "POST", token: "tenant-token" }),
    );
    create.unmount();

    mockApiRequest.mockClear();
    mockApiRequest.mockResolvedValueOnce(loadedUser);
    const editor = render(<ManagedUserEditor id={loadedUser.id} />);
    await waitFor(() =>
      expect(editor.getByText("Akses pengguna")).toBeTruthy(),
    );
    expect(mockApiRequest).toHaveBeenCalledWith(
      `/management/users/${loadedUser.id}`,
      expect.objectContaining({ token: "tenant-token" }),
    );
  });

  it("keeps Kelola tenant inside the active business session", async () => {
    mockApiRequest.mockImplementation((path: string) =>
      Promise.resolve(
        path === "/auth/contexts"
          ? { tenantProvisioningEnabled: true }
          : [
              {
                id: "tenant-a",
                name: "Bisnis A",
                slug: "bisnis-a",
                status: "active",
                revision: 1,
              },
            ],
      ),
    );
    const screen = render(<ManagedTenantsScreen />);
    await waitFor(() => expect(screen.getByText("Bisnis A")).toBeTruthy());
    expect(screen.queryByText("/contexts")).toBeNull();
    expect(mockApiRequest).toHaveBeenCalledWith(
      "/management/tenants",
      expect.objectContaining({ token: "tenant-token" }),
    );
  });

  it("rejects the retired platform context without requesting organization data", () => {
    mockSession = retiredPlatformSession;
    const screen = render(<UsersScreen />);
    expect(screen.getByText("/contexts")).toBeTruthy();
    expect(mockApiRequest).not.toHaveBeenCalled();
  });

  it("rejects a signed-out session", () => {
    mockSession = null;
    const screen = render(<UsersScreen />);
    expect(screen.getByText("/contexts")).toBeTruthy();
    expect(mockApiRequest).not.toHaveBeenCalled();
  });
});
