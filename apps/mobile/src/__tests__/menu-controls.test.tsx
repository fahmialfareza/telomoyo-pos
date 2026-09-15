import { fireEvent, render } from "@testing-library/react-native";

import { IconButton } from "@/components/ui/IconButton";
import { MenuRow } from "@/components/ui/MenuRow";
import { PageHeader } from "@/components/layout/PageHeader";

const mockBack = jest.fn();
jest.mock("expo-router", () => ({ useRouter: () => ({ back: mockBack }) }));
jest.mock("@/components/ui/Icon", () => ({ Icon: () => null }));

it("offers an icon-only refresh action with a spoken label and busy guard", () => {
  const refresh = jest.fn();
  const screen = render(<IconButton icon="refresh" label="Muat ulang pengguna" onPress={refresh} />);
  const button = screen.getByRole("button", { name: "Muat ulang pengguna" });
  expect(screen.queryByText("Muat ulang pengguna")).toBeNull();
  fireEvent.press(button);
  expect(refresh).toHaveBeenCalledTimes(1);
  screen.rerender(<IconButton icon="refresh" label="Muat ulang pengguna" onPress={refresh} loading />);
  expect(screen.getByRole("button", { name: "Muat ulang pengguna" })).toBeDisabled();
  fireEvent.press(screen.getByRole("button", { name: "Muat ulang pengguna" }));
  expect(refresh).toHaveBeenCalledTimes(1);
});

it("makes the entire settings-style row actionable with readable selection/status", () => {
  const open = jest.fn();
  const screen = render(<MenuRow icon="store-outline" title="Ojek Telomoyo" detail="Bisnis aktif" status="Sedang dipilih" selected onPress={open} accessibilityLabel="Lanjutkan bisnis Ojek Telomoyo" />);
  const row = screen.getByRole("button", { name: "Lanjutkan bisnis Ojek Telomoyo" });
  expect(row.props.accessibilityState.selected).toBe(true);
  expect(screen.getByText("Sedang dipilih")).toBeTruthy();
  fireEvent.press(row);
  expect(open).toHaveBeenCalledTimes(1);
  screen.rerender(<MenuRow icon="store-outline" title="Bisnis ditangguhkan" disabled onPress={open} />);
  fireEvent.press(screen.getByRole("button"));
  expect(open).toHaveBeenCalledTimes(1);
});

it("supports inline editor Back without leaving the tab route", () => {
  const inlineBack = jest.fn();
  const screen = render(<PageHeader back title="Kelola akun" onBack={inlineBack} />);
  fireEvent.press(screen.getByRole("button", { name: "Kembali" }));
  expect(inlineBack).toHaveBeenCalledTimes(1);
  expect(mockBack).not.toHaveBeenCalled();
});
