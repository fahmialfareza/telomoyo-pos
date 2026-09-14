import { Platform, type TextStyle, type ViewStyle } from "react-native";

export const colors = {
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

export const textStyles = {
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

export const cardStyle = {
  backgroundColor: colors.card,
  borderColor: colors.outline,
  borderWidth: 1,
  borderRadius: radius.lg,
} satisfies ViewStyle;

export const minimumTouchTarget = 48;

export const monoNumericStyle: TextStyle = {
  fontVariant: ["tabular-nums"],
  ...Platform.select({
    android: { includeFontPadding: false },
    default: {},
  }),
};
