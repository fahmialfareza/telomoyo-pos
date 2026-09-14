import { useResponsiveStyles } from "@/theme/responsive";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  type PressableProps,
  type ViewStyle,
  type StyleProp,
} from "react-native";

import {
  colors,
  minimumTouchTarget,
  radius,
  spacing,
  typography,
} from "@/theme/tokens";

import { Icon, type IconName } from "./Icon";

type ButtonVariant =
  "primary" | "secondary" | "danger" | "dangerSolid" | "ghost";

interface ButtonProps extends Omit<PressableProps, "style"> {
  children: string;
  variant?: ButtonVariant;
  icon?: IconName;
  loading?: boolean;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function Button({
  children,
  variant = "primary",
  icon,
  loading = false,
  compact = false,
  disabled,
  style,
  ...props
}: ButtonProps) {
  const responsive = useResponsiveStyles(styles);
  const foreground =
    variant === "primary" || variant === "dangerSolid"
      ? colors.onPrimary
      : variant === "danger"
        ? colors.error
        : colors.primary;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{
        disabled: Boolean(disabled || loading),
        busy: loading,
      }}
      disabled={disabled || loading}
      style={({ pressed }) => [
        responsive.base,
        compact && responsive.compact,
        styles[variant],
        pressed && responsive.pressed,
        (disabled || loading) && responsive.disabled,
        style,
      ]}
      {...props}
    >
      {loading ? (
        <ActivityIndicator color={foreground} />
      ) : icon ? (
        <Icon color={foreground} name={icon} size={20} />
      ) : null}
      <Text style={[responsive.text, { color: foreground }]}>{children}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: minimumTouchTarget,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
  },
  compact: {
    minHeight: minimumTouchTarget,
    alignSelf: "flex-start",
  },
  primary: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  secondary: {
    backgroundColor: colors.card,
    borderColor: colors.primary,
  },
  danger: {
    backgroundColor: colors.card,
    borderColor: colors.error,
  },
  dangerSolid: {
    backgroundColor: colors.error,
    borderColor: colors.error,
  },
  ghost: {
    backgroundColor: "transparent",
    borderColor: "transparent",
  },
  text: {
    fontFamily: typography.bodySemibold,
    fontSize: 15,
    textAlign: "center",
    flexShrink: 1,
  },
  pressed: {
    opacity: 0.8,
    transform: [{ scale: 0.985 }],
  },
  disabled: {
    opacity: 0.45,
  },
});
