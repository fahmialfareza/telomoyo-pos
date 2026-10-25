import { Platform, type TextStyle, type ViewStyle } from "react-native";

export const lightColors = {
  surface: "#F4F5F7",
  surfaceBright: "#FAF8FF",
  card: "#FFFFFF",
  container: "#EDEDF8",
  containerHigh: "#E7E7F2",
  text: "#191B23",
  textMuted: "#5E6270",
  outline: "#C3C6D6",
  primary: "#003D9B",
  primaryBright: "#0052CC",
  primarySoft: "#DAE2FF",
  onPrimary: "#FFFFFF",
  secondary: "#00687A",
  standard: "#5243AA",
  sunrise: "#FF8B00",
  success: "#238A62",
  successSoft: "#E7F6F0",
  warning: "#A45B00",
  warningSoft: "#FFF2DB",
  error: "#BA1A1A",
  errorSoft: "#FFDAD6",
  unknown: "#6B7280",
} as const;

export type Palette = Record<keyof typeof lightColors, string>;

export const darkColors: Palette = {
  surface: "#111318",
  surfaceBright: "#1F2330",
  card: "#1B1E26",
  container: "#262A35",
  containerHigh: "#2F3441",
  text: "#E3E5EE",
  textMuted: "#A3A8B8",
  outline: "#3A3F4E",
  primary: "#AFC6FF",
  primaryBright: "#D9E2FF",
  primarySoft: "#1E3A75",
  onPrimary: "#00296B",
  secondary: "#7BD3E8",
  standard: "#C3B8FF",
  sunrise: "#FFB866",
  success: "#6DD3A3",
  successSoft: "#12352A",
  warning: "#FFB95C",
  warningSoft: "#3A2A10",
  error: "#FFB4AB",
  errorSoft: "#4A1714",
  unknown: "#9CA3AF",
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;

export const radius = {
  sm: 4,
  md: 8,
  lg: 12,
  xl: 18,
  pill: 999,
} as const;

export const typography = {
  heading: "Roboto_700Bold",
  headingSemibold: "Roboto_600SemiBold",
  price: "Roboto_800ExtraBold",
  body: "Roboto_400Regular",
  bodyMedium: "Roboto_500Medium",
  bodySemibold: "Roboto_600SemiBold",
  mono: "JetBrainsMono_500Medium",
} as const;

export function createTextStyles(colors: Palette) {
  return {
    subpage: {
      fontFamily: typography.heading,
      fontSize: 22,
      lineHeight: 28,
      letterSpacing: -0.2,
      color: colors.text,
    } satisfies TextStyle,
    title: {
      fontFamily: typography.heading,
      fontSize: 24,
      lineHeight: 30,
      letterSpacing: -0.45,
      color: colors.text,
    } satisfies TextStyle,
    heading: {
      fontFamily: typography.headingSemibold,
      fontSize: 18,
      lineHeight: 25,
      letterSpacing: -0.2,
      color: colors.text,
    } satisfies TextStyle,
    body: {
      fontFamily: typography.body,
      fontSize: 14,
      lineHeight: 21,
      color: colors.text,
    } satisfies TextStyle,
    label: {
      fontFamily: typography.bodyMedium,
      fontSize: 12,
      lineHeight: 16,
      letterSpacing: 0.4,
      color: colors.textMuted,
    } satisfies TextStyle,
    technical: {
      fontFamily: typography.mono,
      fontSize: 12,
      lineHeight: 16,
      letterSpacing: 0.4,
      color: colors.textMuted,
    } satisfies TextStyle,
    price: {
      fontFamily: typography.price,
      fontSize: 28,
      lineHeight: 36,
      letterSpacing: -0.6,
      color: colors.primary,
    } satisfies TextStyle,
  } as const;
}

export function createCardStyle(colors: Palette) {
  return {
    backgroundColor: colors.card,
    borderColor: colors.outline,
    borderWidth: 1,
    borderRadius: radius.lg,
  } satisfies ViewStyle;
}

export const minimumTouchTarget = 48;

export const monoNumericStyle: TextStyle = {
  fontVariant: ["tabular-nums"],
  ...Platform.select({
    android: { includeFontPadding: false },
    default: {},
  }),
};

export type ColorScheme = "light" | "dark";
export type TextStyles = ReturnType<typeof createTextStyles>;

export interface Theme {
  scheme: ColorScheme;
  colors: Palette;
  textStyles: TextStyles;
  cardStyle: ReturnType<typeof createCardStyle>;
}

function createTheme(scheme: ColorScheme, colors: Palette): Theme {
  return {
    scheme,
    colors,
    textStyles: createTextStyles(colors),
    cardStyle: createCardStyle(colors),
  };
}

export const lightTheme = createTheme("light", lightColors);
export const darkTheme = createTheme("dark", darkColors);
