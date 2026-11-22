import {
  Platform,
  StyleSheet,
  type TextStyle,
  type ViewStyle,
} from "react-native";

export const lightColors = {
  surface: "#FAFAFA",
  surfaceBright: "#FFFFFF",
  card: "#FFFFFF",
  container: "#F4F4F5",
  containerHigh: "#E4E4E7",
  text: "#18181B",
  textMuted: "#66666E",
  outline: "#E4E4E7",
  primary: "#1D4ED8",
  primaryBright: "#2563EB",
  primarySoft: "#EFF4FF",
  onPrimary: "#FFFFFF",
  secondary: "#0E7490",
  standard: "#6D28D9",
  sunrise: "#C2410C",
  success: "#15803D",
  successSoft: "#F0FDF4",
  warning: "#B45309",
  warningSoft: "#FFFBEB",
  error: "#B91C1C",
  errorSoft: "#FEF2F2",
  unknown: "#66666E",
} as const;

export type Palette = Record<keyof typeof lightColors, string>;

export const darkColors: Palette = {
  surface: "#09090B",
  surfaceBright: "#18181B",
  card: "#18181B",
  container: "#27272A",
  containerHigh: "#3F3F46",
  text: "#FAFAFA",
  textMuted: "#A1A1AA",
  outline: "#2E2E33",
  primary: "#8AB4FF",
  primaryBright: "#BFD4FF",
  primarySoft: "#172554",
  onPrimary: "#0A1A3F",
  secondary: "#67E8F9",
  standard: "#C4B5FD",
  sunrise: "#FDBA74",
  success: "#4ADE80",
  successSoft: "#052E16",
  warning: "#FBBF24",
  warningSoft: "#2A1D05",
  error: "#F87171",
  errorSoft: "#2A0F0F",
  unknown: "#A1A1AA",
};

// responsiveStyles() remaps these exact values, so keep them stable.
export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  pill: 999,
} as const;

export const typography = {
  heading: "Inter_700Bold",
  headingSemibold: "Inter_600SemiBold",
  price: "Inter_700Bold",
  body: "Inter_400Regular",
  bodyMedium: "Inter_500Medium",
  bodySemibold: "Inter_600SemiBold",
  mono: "JetBrainsMono_500Medium",
} as const;

export function createTextStyles(colors: Palette) {
  return {
    subpage: {
      fontFamily: typography.headingSemibold,
      fontSize: 20,
      lineHeight: 26,
      letterSpacing: -0.3,
      color: colors.text,
    } satisfies TextStyle,
    title: {
      fontFamily: typography.heading,
      fontSize: 28,
      lineHeight: 34,
      letterSpacing: -0.6,
      color: colors.text,
    } satisfies TextStyle,
    heading: {
      fontFamily: typography.headingSemibold,
      fontSize: 17,
      lineHeight: 24,
      letterSpacing: -0.2,
      color: colors.text,
    } satisfies TextStyle,
    body: {
      fontFamily: typography.body,
      fontSize: 15,
      lineHeight: 22,
      color: colors.text,
    } satisfies TextStyle,
    label: {
      fontFamily: typography.bodyMedium,
      fontSize: 13,
      lineHeight: 18,
      color: colors.textMuted,
    } satisfies TextStyle,
    technical: {
      fontFamily: typography.mono,
      fontSize: 12,
      lineHeight: 16,
      letterSpacing: 0.2,
      color: colors.textMuted,
    } satisfies TextStyle,
    price: {
      fontFamily: typography.price,
      fontSize: 32,
      lineHeight: 38,
      letterSpacing: -0.8,
      color: colors.text,
      fontVariant: ["tabular-nums"],
    } satisfies TextStyle,
  } as const;
}

export function createCardStyle(colors: Palette) {
  return {
    backgroundColor: colors.card,
    borderColor: colors.outline,
    borderWidth: StyleSheet.hairlineWidth,
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
