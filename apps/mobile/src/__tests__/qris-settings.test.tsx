import {
  act,
  fireEvent,
  render as renderScreen,
  waitFor,
} from "@testing-library/react-native";
import type { ReactNode } from "react";
import { TextInput } from "react-native";
import { ConfirmationProvider } from "@/components/ui/ConfirmationProvider";

import QrisSettingsScreen from "@/app/(app)/settings/qris";

const STATIC_QRIS =
  "00020101021126320014ID.CO.TEST.WWW011012345678905204729953033605802ID5910SEWA MOTOR6008DENPASAR6304AA64";

const mockAuthState = {
  role: "superadmin" as "superadmin" | "admin",
};
// Zustand keeps the session reference stable between unrelated screen renders.
const mockSession = {
  token: "tenant-token",
  dataMode: "production",
  tenantId: "00000000-0000-4000-8000-000000000200",
  user: {
    get role() {
      return mockAuthState.role;
    },
  },
};
const mockReadQrisConfig = jest.fn();
const mockWriteQrisConfig = jest.fn();
const mockClearQrisConfig = jest.fn();
const mockGetPendingResult = jest.fn();
const mockRequestCameraPermission = jest.fn();
const mockLaunchCamera = jest.fn();
const mockLaunchImageLibrary = jest.fn();
const mockScanFromURL = jest.fn();
const mockApiRequest = jest.fn();

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

jest.mock("@/api/client", () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}));
jest.mock("@/tenant/configuration", () => ({
  cacheTenantConfiguration: jest.fn(),
}));

jest.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({
    session: mockSession,
  }),
}));

jest.mock("@/security/secure-store", () => ({
  readLegacyQrisConfig: async () => null,
  readQrisConfig: () => mockReadQrisConfig(),
  writeQrisConfig: (value: unknown) => mockWriteQrisConfig(value),
  clearQrisConfig: () => mockClearQrisConfig(),
}));

jest.mock("expo-image-picker", () => ({
  CameraType: { back: "back" },
  getPendingResultAsync: () => mockGetPendingResult(),
  requestCameraPermissionsAsync: () => mockRequestCameraPermission(),
  launchCameraAsync: (options: unknown) => mockLaunchCamera(options),
  launchImageLibraryAsync: (options: unknown) =>
    mockLaunchImageLibrary(options),
}));

jest.mock("expo-camera", () => ({
  scanFromURLAsync: (uri: string, types: string[]) =>
    mockScanFromURL(uri, types),
}));

jest.mock("react-native-qrcode-svg", () => {
  const { Text, View } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    __esModule: true,
    default: ({ value }: { value: string }) => (
      <View accessibilityLabel="Pratinjau QRIS" testID="qris-preview">
        <Text>{value.slice(0, 6)}</Text>
      </View>
    ),
  };
});

jest.mock("@/components/layout/AppScreen", () => {
  const { View } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    AppScreen: ({ children }: { children?: ReactNode }) => (
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

jest.mock("@/components/ui/Card", () => {
  const { View } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    Card: ({ children }: { children?: ReactNode }) => <View>{children}</View>,
  };
});

jest.mock("@/components/ui/Icon", () => ({
  Icon: () => null,
}));

jest.mock("@/components/ui/StateView", () => {
  const { Text, View } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    StateView: ({ message, title }: { message: string; title: string }) => (
      <View>
        <Text>{title}</Text>
        <Text>{message}</Text>
      </View>
    ),
  };
});

function pickedImage(uri = "file:///qris.jpg") {
  return {
    canceled: false as const,
    assets: [
      {
        uri,
        width: 1200,
        height: 1200,
        fileSize: 300_000,
        type: "image" as const,
      },
    ],
  };
}

function qrResult(payload = STATIC_QRIS) {
  return [{ data: payload }];
}

describe("QRIS settings image flow", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthState.role = "superadmin";
    mockReadQrisConfig.mockResolvedValue(null);
    mockApiRequest.mockImplementation(
      async (
        _path: string,
        options: {
          method?: string;
          body?: { staticPayload: string; activate?: boolean };
        },
      ) => {
        const writing = options.method === "PUT";
        const config = writing ? options.body : await mockReadQrisConfig();
        if (writing && config)
          await mockWriteQrisConfig({ staticPayload: config.staticPayload });
        return {
          revision: config ? 1 : 0,
          activePayloadHash:
            config && options.body?.activate !== false ? "hash" : null,
          payloads: config
            ? [
                {
                  payloadHash: "hash",
                  staticPayload: config.staticPayload,
                  revision: 1,
                },
              ]
            : [],
        };
      },
    );
    mockWriteQrisConfig.mockResolvedValue(undefined);
    mockClearQrisConfig.mockResolvedValue(undefined);
    mockGetPendingResult.mockResolvedValue(null);
    mockRequestCameraPermission.mockResolvedValue({
      granted: true,
      canAskAgain: true,
    });
    mockLaunchCamera.mockResolvedValue({ canceled: true, assets: null });
    mockLaunchImageLibrary.mockResolvedValue({
      canceled: true,
      assets: null,
    });
    mockScanFromURL.mockResolvedValue([]);
  });

  it("renders a saved static QRIS as locked with no editable payload field", async () => {
    mockReadQrisConfig.mockResolvedValue({ staticPayload: STATIC_QRIS });
    const screen = render(<QrisSettingsScreen />);

    await waitFor(() => {
      expect(screen.getByText("QRIS STATIS TERKUNCI")).toBeTruthy();
    });
    expect(screen.UNSAFE_queryAllByType(TextInput)).toHaveLength(0);
    expect(screen.getByText("Payload tidak dapat diedit manual.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Ganti QRIS statis" }),
    ).toBeTruthy();
  });

  it("stages a gallery QRIS for review and writes only after Save", async () => {
    mockLaunchImageLibrary.mockResolvedValue(pickedImage());
    mockScanFromURL.mockResolvedValue(qrResult());
    const screen = render(<QrisSettingsScreen />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Pilih gambar QRIS" }),
      ).toBeTruthy();
    });
    fireEvent.press(screen.getByRole("button", { name: "Pilih gambar QRIS" }));

    await waitFor(() => {
      expect(screen.getByText("QRIS STATIS TERBACA")).toBeTruthy();
    });
    expect(mockScanFromURL).toHaveBeenCalledWith("file:///qris.jpg", ["qr"]);
    expect(mockWriteQrisConfig).not.toHaveBeenCalled();

    fireEvent.press(screen.getByRole("button", { name: "Simpan QRIS statis" }));

    await waitFor(() => {
      expect(mockWriteQrisConfig).toHaveBeenCalledWith({
        staticPayload: STATIC_QRIS,
      });
      expect(screen.getByText("QRIS STATIS TERKUNCI")).toBeTruthy();
    });
    expect(mockApiRequest).toHaveBeenCalledWith("/tenant/qris", {
      method: "PUT",
      token: "tenant-token",
      body: { expectedRevision: 0, staticPayload: STATIC_QRIS, activate: true },
    });
  });

  it("requires confirmation and preserves the old QRIS when replacement scanning fails", async () => {
    mockReadQrisConfig.mockResolvedValue({ staticPayload: STATIC_QRIS });
    mockLaunchImageLibrary.mockResolvedValue(pickedImage("file:///empty.jpg"));
    const screen = render(<QrisSettingsScreen />);

    await waitFor(() => {
      expect(screen.getByText("QRIS STATIS TERKUNCI")).toBeTruthy();
    });
    fireEvent.press(screen.getByRole("button", { name: "Ganti QRIS statis" }));

    expect(screen.getByText("Ganti QRIS statis?")).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: "Lanjutkan" }));
    await waitFor(() =>
      expect(screen.queryByText("Ganti QRIS statis?")).toBeNull(),
    );
    fireEvent.press(screen.getByRole("button", { name: "Pilih gambar QRIS" }));

    await waitFor(() => {
      expect(screen.getByText(/Kode QR tidak ditemukan/)).toBeTruthy();
    });
    expect(mockWriteQrisConfig).not.toHaveBeenCalled();
    expect(mockClearQrisConfig).not.toHaveBeenCalled();

    fireEvent.press(screen.getByRole("button", { name: "Batal mengganti" }));
    expect(screen.getByText("QRIS STATIS TERKUNCI")).toBeTruthy();
  });

  it("does not open the camera when permission is denied", async () => {
    mockRequestCameraPermission.mockResolvedValue({
      granted: false,
      canAskAgain: false,
    });
    const screen = render(<QrisSettingsScreen />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Ambil foto QRIS" }),
      ).toBeTruthy();
    });
    fireEvent.press(screen.getByRole("button", { name: "Ambil foto QRIS" }));

    await waitFor(() => {
      expect(screen.getByText(/Aktifkan izin Kamera/)).toBeTruthy();
    });
    expect(mockLaunchCamera).not.toHaveBeenCalled();
  });

  it("uses the labeled switch to store a historical-only version", async () => {
    mockLaunchImageLibrary.mockResolvedValue(pickedImage());
    mockScanFromURL.mockResolvedValue(qrResult());
    const screen = render(<QrisSettingsScreen />);
    fireEvent.press(
      await screen.findByRole("button", { name: "Pilih gambar QRIS" }),
    );
    const activation = await screen.findByLabelText(
      "Gunakan QRIS untuk transaksi baru",
    );
    expect(activation.props.value).toBe(true);
    fireEvent(activation, "valueChange", false);
    expect(
      screen.getByText(
        "Simpan sebagai versi historis saja; QRIS aktif tidak berubah.",
      ),
    ).toBeTruthy();
    expect(mockWriteQrisConfig).not.toHaveBeenCalled();
    fireEvent.press(screen.getByRole("button", { name: "Simpan QRIS statis" }));
    await waitFor(() =>
      expect(mockApiRequest).toHaveBeenCalledWith("/tenant/qris", {
        method: "PUT",
        token: "tenant-token",
        body: {
          expectedRevision: 0,
          staticPayload: STATIC_QRIS,
          activate: false,
        },
      }),
    );
    expect(
      await screen.findByText(
        "Versi QRIS historis tersimpan. QRIS aktif tidak berubah.",
      ),
    ).toBeTruthy();
  });

  it("canceling a candidate never saves or clears the merchant source", async () => {
    mockLaunchImageLibrary.mockResolvedValue(pickedImage());
    mockScanFromURL.mockResolvedValue(qrResult());
    const screen = render(<QrisSettingsScreen />);
    fireEvent.press(
      await screen.findByRole("button", { name: "Pilih gambar QRIS" }),
    );
    fireEvent.press(await screen.findByRole("button", { name: "Batalkan" }));
    expect(screen.queryByText("QRIS STATIS TERBACA")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Pilih gambar QRIS" }),
    ).toBeTruthy();
    expect(
      mockApiRequest.mock.calls.every(
        ([, options]) => options.method !== "PUT",
      ),
    ).toBe(true);
    expect(mockWriteQrisConfig).not.toHaveBeenCalled();
    expect(mockClearQrisConfig).not.toHaveBeenCalled();
  });

  it("canceling the replacement confirmation leaves the saved source selected", async () => {
    mockReadQrisConfig.mockResolvedValue({ staticPayload: STATIC_QRIS });
    const screen = render(<QrisSettingsScreen />);
    fireEvent.press(
      await screen.findByRole("button", { name: "Ganti QRIS statis" }),
    );
    fireEvent.press(screen.getByRole("button", { name: "Batal" }));
    expect(screen.getByText("QRIS STATIS TERKUNCI")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Pilih gambar QRIS" }),
    ).toBeNull();
    expect(mockWriteQrisConfig).not.toHaveBeenCalled();
    expect(mockClearQrisConfig).not.toHaveBeenCalled();
  });

  it("recovers an Android pending image as an unsaved candidate", async () => {
    mockGetPendingResult.mockResolvedValue(pickedImage("file:///pending.jpg"));
    mockScanFromURL.mockResolvedValue(qrResult());
    const screen = render(<QrisSettingsScreen />);

    await waitFor(() => {
      expect(screen.getByText("QRIS STATIS TERBACA")).toBeTruthy();
    });
    expect(mockScanFromURL).toHaveBeenCalledWith("file:///pending.jpg", ["qr"]);
    expect(mockWriteQrisConfig).not.toHaveBeenCalled();
  });

  it("does not read QRIS configuration for a non-superadmin", async () => {
    mockAuthState.role = "admin";
    const screen = render(<QrisSettingsScreen />);

    expect(screen.getByText("Akses dibatasi")).toBeTruthy();
    await act(async () => undefined);
    expect(mockReadQrisConfig).not.toHaveBeenCalled();
  });
});
