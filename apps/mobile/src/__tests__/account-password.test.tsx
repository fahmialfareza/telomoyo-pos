import { fireEvent, render } from "@testing-library/react-native";
import type { ReactNode } from "react";

import PasswordScreen from "@/app/account-password";
import ProfileScreen from "@/app/account-profile";
import LegacyPasswordRoute from "@/app/(app)/settings/password";
import type { Session } from "@/domain/types";

const initial: Session = {
  token: "token",
  sessionId: "account-session",
  contextKind: "account",
  dataMode: "production",
  dataSpaceId: "",
  sandboxGeneration: null,
  establishedAt: "2026-09-14T00:00:00Z",
  user: {
    id: "user",
    username: "staff",
    fullName: "Staff",
    role: "admin",
    active: true,
    mustChangePassword: false,
  },
};
let mockSession: Session | null = initial;
let mockLocked = false;
const mockChangePassword = jest.fn();
const mockPush = jest.fn();
jest.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({
    session: mockSession,
    booting: false,
    scopeLocked: mockLocked,
    changePassword: mockChangePassword,
    updateProfile: jest.fn(),
  }),
}));
jest.mock("expo-router", () => {
  const { Text } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    useRouter: () => ({ push: mockPush }),
    Redirect: ({ href }: { href: string }) => <Text>{href}</Text>,
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
  const { Text } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return { PageHeader: ({ title }: { title: string }) => <Text>{title}</Text> };
});
jest.mock("@/components/ui/Icon", () => ({ Icon: () => null }));
jest.mock("@/components/forms/PasswordForm", () => {
  const { Pressable, Text } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    PasswordForm: ({
      onSubmit,
    }: {
      onSubmit: (current: string, next: string) => void;
    }) => (
      <Pressable
        testID="password-form"
        onPress={() => onSubmit("current-password", "replacement-password")}
      >
        <Text>Formulir kata sandi</Text>
      </Pressable>
    ),
  };
});

beforeEach(() => {
  mockSession = initial;
  mockLocked = false;
  jest.clearAllMocks();
});

it("allows a signed-in account without a business to use the independent password screen", () => {
  const screen = render(<PasswordScreen />);
  fireEvent.press(screen.getByTestId("password-form"));
  expect(mockChangePassword).toHaveBeenCalledWith(
    "current-password",
    "replacement-password",
  );
});

it("keeps profile focused on identity with a separate password link", () => {
  const screen = render(<ProfileScreen />);
  expect(screen.queryByTestId("password-form")).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Ganti kata sandi" }));
  expect(mockPush).toHaveBeenCalledWith("/account-password");
});

it("keeps Sandbox password changes locked", () => {
  mockSession = { ...initial, contextKind: "tenant", dataMode: "sandbox" };
  const screen = render(<PasswordScreen />);
  expect(screen.getByText("Tidak tersedia di Mode Uji")).toBeTruthy();
  expect(screen.queryByTestId("password-form")).toBeNull();
});

it("requires login and honors forced password changes", () => {
  mockSession = null;
  const screen = render(<PasswordScreen />);
  expect(screen.getByText("/(auth)/login")).toBeTruthy();
  mockSession = {
    ...initial,
    user: { ...initial.user, mustChangePassword: true },
  };
  screen.rerender(<PasswordScreen />);
  expect(screen.getByText("/(auth)/change-password")).toBeTruthy();
  expect(screen.queryByTestId("password-form")).toBeNull();
});

it("does not bypass a locked business scope", () => {
  mockLocked = true;
  expect(render(<PasswordScreen />).getByText("/contexts")).toBeTruthy();
});

it("preserves the previous password URL as an alias", () => {
  expect(
    render(<LegacyPasswordRoute />).getByText("/account-password"),
  ).toBeTruthy();
});
