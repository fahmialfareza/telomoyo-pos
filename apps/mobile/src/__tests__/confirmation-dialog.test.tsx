import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Modal } from "react-native";

import { Button } from "@/components/ui/Button";
import {
  ConfirmationProvider,
  useConfirmation,
} from "@/components/ui/ConfirmationProvider";

let mockAuth = { session: { sessionId: "session-1" }, switchingMode: false };
const mockListeners = new Set<
  (next: typeof mockAuth, previous: typeof mockAuth) => void
>();
function updateAuth(next: typeof mockAuth) {
  const previous = mockAuth;
  mockAuth = next;
  mockListeners.forEach((listener) => listener(next, previous));
}
jest.mock("@/auth/auth-store", () => ({
  useAuthStore: Object.assign(
    (select: (state: typeof mockAuth) => unknown) => select(mockAuth),
    {
      getState: () => mockAuth,
      subscribe: (
        listener: (next: typeof mockAuth, previous: typeof mockAuth) => void,
      ) => {
        mockListeners.add(listener);
        return () => mockListeners.delete(listener);
      },
    },
  ),
}));
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));

function Harness({ onConfirm }: { onConfirm: () => void | Promise<void> }) {
  const { confirm } = useConfirmation();
  return (
    <Button
      onPress={() =>
        confirm({
          title: "Konfirmasi",
          message: "Periksa kembali",
          confirmLabel: "Lanjutkan",
          destructive: true,
          onConfirm,
        })
      }
    >
      Buka
    </Button>
  );
}
function App({ onConfirm }: { onConfirm: () => void | Promise<void> }) {
  return (
    <ConfirmationProvider>
      <Harness onConfirm={onConfirm} />
    </ConfirmationProvider>
  );
}

describe("app confirmation dialogs", () => {
  beforeEach(() => {
    mockAuth = { session: { sessionId: "session-1" }, switchingMode: false };
  });

  it("cancel and Android Back never execute the operation", () => {
    const onConfirm = jest.fn();
    const screen = render(<App onConfirm={onConfirm} />);
    fireEvent.press(screen.getByRole("button", { name: "Buka" }));
    fireEvent.press(screen.getByRole("button", { name: "Batal" }));
    expect(screen.queryByText("Periksa kembali")).toBeNull();
    fireEvent.press(screen.getByRole("button", { name: "Buka" }));
    act(() => screen.UNSAFE_getByType(Modal).props.onRequestClose());
    expect(screen.queryByText("Periksa kembali")).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("executes confirmation once and prevents repeated taps while pending", async () => {
    let resolve!: () => void;
    const onConfirm = jest.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const screen = render(<App onConfirm={onConfirm} />);
    fireEvent.press(screen.getByRole("button", { name: "Buka" }));
    fireEvent.press(screen.getByRole("button", { name: "Lanjutkan" }));
    fireEvent.press(screen.getByRole("button", { name: "Lanjutkan" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await act(async () => resolve());
    expect(screen.queryByText("Periksa kembali")).toBeNull();
  });

  it.each(["switch", "session"])(
    "dismisses a pending dialog on %s changes without replay",
    (change) => {
      const onConfirm = jest.fn();
      const screen = render(<App onConfirm={onConfirm} />);
      fireEvent.press(screen.getByRole("button", { name: "Buka" }));
      act(() =>
        updateAuth(
          change === "switch"
            ? { ...mockAuth, switchingMode: true }
            : { ...mockAuth, session: { sessionId: "session-2" } },
        ),
      );
      screen.rerender(<App onConfirm={onConfirm} />);
      expect(screen.queryByText("Periksa kembali")).toBeNull();
      act(() => updateAuth({ ...mockAuth, switchingMode: false }));
      screen.rerender(<App onConfirm={onConfirm} />);
      expect(screen.queryByText("Periksa kembali")).toBeNull();
      expect(onConfirm).not.toHaveBeenCalled();
    },
  );

  it("shows a recoverable error after a failed confirmation", async () => {
    const onConfirm = jest
      .fn()
      .mockRejectedValueOnce(new Error("Tidak dapat menyimpan"))
      .mockResolvedValue(undefined);
    const screen = render(<App onConfirm={onConfirm} />);
    fireEvent.press(screen.getByRole("button", { name: "Buka" }));
    fireEvent.press(screen.getByRole("button", { name: "Lanjutkan" }));
    await waitFor(() => {
      expect(screen.getByText("Tidak dapat menyimpan")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Lanjutkan" })).toHaveProp(
        "accessibilityState",
        expect.objectContaining({ busy: false, disabled: false }),
      );
    });
    fireEvent.press(screen.getByRole("button", { name: "Lanjutkan" }));
    await waitFor(
      () => expect(screen.queryByText("Periksa kembali")).toBeNull(),
      { timeout: 5000 },
    );
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });
});
