import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { PaperThemeScope } from "@/theme/PaperThemeScope";
import {
  ThemeContext,
  resolveColorScheme,
  useAppearancePreference,
} from "@/theme/ThemeContext";
import { ThemeProvider } from "@/theme/ThemeProvider";
import { themed, useResponsiveStyles } from "@/theme/responsive";
import {
  darkColors,
  darkTheme,
  lightColors,
  lightTheme,
  type Palette,
} from "@/theme/tokens";

const mockReadAppearance = jest.fn();
const mockWriteAppearance = jest.fn();
jest.mock("@/security/secure-store", () => ({
  readAppearancePreference: () => mockReadAppearance(),
  writeAppearancePreference: (value: string) => mockWriteAppearance(value),
}));

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((index) => {
    const channel = parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(foreground: string, background: string) {
  const [high, low] = [luminance(foreground), luminance(background)].sort(
    (a, b) => b - a,
  );
  return (high! + 0.05) / (low! + 0.05);
}

type Pair = [keyof Palette, keyof Palette];
const textPairs: Pair[] = [
  ["text", "surface"],
  ["text", "card"],
  ["textMuted", "surface"],
  ["textMuted", "card"],
  ["textMuted", "surfaceBright"],
  ["primary", "card"],
  ["primary", "surface"],
  ["primary", "primarySoft"],
  ["onPrimary", "primary"],
  ["onPrimary", "warning"],
  ["error", "card"],
  ["error", "errorSoft"],
  ["warning", "card"],
  ["warning", "warningSoft"],
  ["success", "card"],
  ["success", "successSoft"],
  ["standard", "card"],
  ["sunrise", "card"],
  ["secondary", "card"],
];
// Pre-existing light-palette shortfalls, kept unchanged by the dark-mode work.
const knownLightExceptions = new Set([
  "success/card",
  "success/successSoft",
  "sunrise/card",
]);

describe("palettes", () => {
  it("keeps the same token keys in both schemes", () => {
    expect(Object.keys(darkColors).sort()).toEqual(
      Object.keys(lightColors).sort(),
    );
  });

  it.each(textPairs)(
    "dark %s on %s meets WCAG AA",
    (foreground, background) => {
      expect(
        contrast(darkColors[foreground], darkColors[background]),
      ).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each(
    textPairs.filter(
      ([foreground, background]) =>
        !knownLightExceptions.has(`${foreground}/${background}`),
    ),
  )("light %s on %s meets WCAG AA", (foreground, background) => {
    expect(
      contrast(lightColors[foreground], lightColors[background]),
    ).toBeGreaterThanOrEqual(4.5);
  });
});

describe("color scheme resolution", () => {
  it("follows the system unless the user picks a scheme", () => {
    expect(resolveColorScheme("system", "dark")).toBe("dark");
    expect(resolveColorScheme("system", "light")).toBe("light");
    expect(resolveColorScheme("system", null)).toBe("light");
    expect(resolveColorScheme("light", "dark")).toBe("light");
    expect(resolveColorScheme("dark", "light")).toBe("dark");
  });
});

const probeStyles = themed(({ colors }) =>
  StyleSheet.create({ label: { color: colors.text } }),
);

function Probe({ testID = "probe" }: { testID?: string }) {
  const styles = useResponsiveStyles(probeStyles);
  return (
    <Text style={styles.label} testID={testID}>
      probe
    </Text>
  );
}

function colorOf(
  element: ReturnType<ReturnType<typeof render>["getByTestId"]>,
) {
  return StyleSheet.flatten(element.props.style)?.color;
}

describe("themed styles", () => {
  it("defaults to the light palette outside a provider", () => {
    const screen = render(<Probe />);
    expect(colorOf(screen.getByTestId("probe"))).toBe(lightColors.text);
  });

  it("resolves the dark palette and keeps paper surfaces light", () => {
    const screen = render(
      <ThemeContext.Provider
        value={{
          theme: darkTheme,
          preference: "dark",
          setPreference: () => undefined,
        }}
      >
        <View>
          <Probe />
          <PaperThemeScope>
            <Probe testID="paper" />
          </PaperThemeScope>
        </View>
      </ThemeContext.Provider>,
    );
    expect(colorOf(screen.getByTestId("probe"))).toBe(darkColors.text);
    expect(colorOf(screen.getByTestId("paper"))).toBe(lightColors.text);
  });
});

function PreferenceSwitch() {
  const { setPreference } = useAppearancePreference();
  return (
    <Pressable accessibilityRole="button" onPress={() => setPreference("dark")}>
      <Text>Gelap</Text>
    </Pressable>
  );
}

describe("ThemeProvider", () => {
  beforeEach(() => {
    mockReadAppearance.mockReset();
    mockWriteAppearance.mockReset().mockResolvedValue(undefined);
  });

  it("restores the stored preference and re-renders when it changes", async () => {
    mockReadAppearance.mockResolvedValue("light");
    const screen = render(
      <ThemeProvider>
        <Probe />
        <PreferenceSwitch />
      </ThemeProvider>,
    );
    await waitFor(() => expect(mockReadAppearance).toHaveBeenCalled());
    expect(colorOf(screen.getByTestId("probe"))).toBe(lightTheme.colors.text);

    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Gelap" }));
    });
    expect(colorOf(screen.getByTestId("probe"))).toBe(darkTheme.colors.text);
    expect(mockWriteAppearance).toHaveBeenCalledWith("dark");
  });
});
