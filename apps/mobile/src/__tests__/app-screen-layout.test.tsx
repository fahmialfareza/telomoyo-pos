import { fireEvent, render } from "@testing-library/react-native";
import { StyleSheet, Text } from "react-native";

import { AppScreen } from "@/components/layout/AppScreen";

let mockSegments = ["(app)", "transactions", "[id]"];
let mockDimensions = { width: 360, height: 640, fontScale: 1, scale: 1 };
jest.mock("react-native/Libraries/Utilities/useWindowDimensions", () => ({
  __esModule: true,
  default: () => mockDimensions,
}));
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn() }),
  useSegments: () => mockSegments,
}));
jest.mock("@/auth/auth-store", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ session: null, notice: null, dismissNotice: jest.fn() }),
}));
jest.mock("@/mode/mode-store", () => ({
  useModeStore: (selector: (state: unknown) => unknown) =>
    selector({ dataMode: "production" }),
}));
jest.mock("@/components/layout/SyncBar", () => ({ SyncBar: () => null }));
jest.mock("react-native-safe-area-context", () => {
  const { View } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 24, bottom: 32, left: 0, right: 0 }),
  };
});
jest.mock("react-native-keyboard-controller", () => {
  const { ScrollView, View } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    KeyboardAwareScrollView: ScrollView,
    KeyboardStickyView: View,
    KeyboardAvoidingView: View,
  };
});

describe("screen footer layout", () => {
  beforeEach(() => {
    mockSegments = ["(app)", "transactions", "[id]"];
    mockDimensions = { width: 360, height: 640, fontScale: 1, scale: 1 };
  });

  it("reserves stack bottom safe area and measures footer for keyboard offset", () => {
    const screen = render(
      <AppScreen authenticated={false} stickyFooter={<Text>Actions</Text>}>
        <Text>Body</Text>
      </AppScreen>,
    );
    const footerScroll = screen.getByTestId("app-screen-footer-scroll");
    expect(
      StyleSheet.flatten(footerScroll.props.contentContainerStyle),
    ).toMatchObject({ padding: 12, paddingBottom: 44, maxWidth: 600 });
    fireEvent(screen.getByTestId("app-screen-sticky-footer"), "layout", {
      nativeEvent: { layout: { height: 180 } },
    });
    expect(screen.getByTestId("app-screen-scroll").props.bottomOffset).toBe(
      192,
    );
    expect(
      screen
        .getByTestId("app-screen-scroll")
        .findAllByType(Text)
        .map((node) => node.props.children),
    ).toEqual(["Body"]);
  });

  it("does not double-count the tab bar bottom inset", () => {
    mockSegments = ["(app)", "(tabs)", "sell"];
    const screen = render(
      <AppScreen authenticated={false} stickyFooter={<Text>Save</Text>} />,
    );
    expect(
      StyleSheet.flatten(
        screen.getByTestId("app-screen-footer-scroll").props
          .contentContainerStyle,
      ).paddingBottom,
    ).toBe(12);
  });

  it("bounds oversized footer groups and keeps them scrollable on a short screen", () => {
    mockDimensions = { ...mockDimensions, height: 320, fontScale: 1.5 };
    const screen = render(
      <AppScreen
        authenticated={false}
        stickyFooter={<Text>Long actions</Text>}
      />,
    );
    const footer = screen.getByTestId("app-screen-footer-scroll");
    expect(StyleSheet.flatten(footer.props.style).maxHeight).toBeCloseTo(
      (320 - 24 - 32) * 0.45,
    );
    expect(footer.props.nestedScrollEnabled).toBe(true);
    expect(footer.props.keyboardShouldPersistTaps).toBe("handled");
  });

  it("centers tablet content and honors an explicit keyboard offset", () => {
    mockDimensions = { ...mockDimensions, width: 768 };
    const screen = render(
      <AppScreen authenticated={false} scrollProps={{ bottomOffset: 42 }}>
        <Text>Content</Text>
      </AppScreen>,
    );
    const scroll = screen.getByTestId("app-screen-scroll");
    expect(scroll.props.bottomOffset).toBe(42);
    expect(
      StyleSheet.flatten(scroll.props.contentContainerStyle),
    ).toMatchObject({
      maxWidth: 600,
      alignSelf: "center",
      padding: 16,
      gap: 20,
    });
  });
});
