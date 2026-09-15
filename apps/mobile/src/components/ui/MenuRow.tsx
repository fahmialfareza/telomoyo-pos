import { useResponsiveStyles } from "@/theme/responsive";
import { Pressable, StyleSheet, Text, View } from "react-native";

import {
  colors,
  minimumTouchTarget,
  spacing,
  textStyles,
  typography,
} from "@/theme/tokens";

import { Icon, type IconName } from "./Icon";

export function MenuRow({
  icon,
  title,
  detail,
  onPress,
  destructive = false,
  disabled = false,
  selected = false,
  accessibilityLabel,
  status,
}: {
  icon: IconName;
  title: string;
  detail?: string;
  onPress: () => void;
  destructive?: boolean;
  disabled?: boolean;
  selected?: boolean;
  accessibilityLabel?: string;
  status?: string;
}) {
  const responsive = useResponsiveStyles(styles);
  const color = destructive ? colors.error : colors.primary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => [
        responsive.row,
        selected && responsive.selected,
        pressed && responsive.pressed,
        disabled && responsive.disabled,
      ]}
    >
      <View style={responsive.icon}>
        <Icon color={color} name={icon} />
      </View>
      <View style={responsive.copy}>
        <Text style={[responsive.title, destructive && { color }]}>
          {title}
        </Text>
        {detail ? <Text style={responsive.detail}>{detail}</Text> : null}
        {status ? <Text style={responsive.status}>{status}</Text> : null}
      </View>
      <Icon
        color={selected ? colors.primary : colors.textMuted}
        name={selected ? "check-circle" : "chevron-right"}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: minimumTouchTarget + 12,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderBottomColor: colors.outline,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  icon: {
    width: 40,
    height: 40,
    backgroundColor: colors.surface,
    justifyContent: "center",
    alignItems: "center",
  },
  copy: { flex: 1, minWidth: 0, gap: 2 },
  title: {
    fontFamily: typography.bodyMedium,
    fontSize: 15,
    color: colors.text,
  },
  detail: { ...textStyles.body, color: colors.textMuted, fontSize: 12 },
  status: { ...textStyles.label, color: colors.primary },
  selected: { backgroundColor: colors.primarySoft },
  disabled: { opacity: 0.5 },
  pressed: { backgroundColor: colors.surface },
});
