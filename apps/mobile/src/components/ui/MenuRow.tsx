import { useResponsiveStyles, themed } from "@/theme/responsive";
import { useThemeColors } from "@/theme/ThemeContext";
import { Pressable, StyleSheet, Text, View } from "react-native";

import {
  minimumTouchTarget,
  radius,
  spacing,
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
  const colors = useThemeColors();
  const responsive = useResponsiveStyles(styles);
  const color = destructive ? colors.error : colors.text;
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
        <Icon color={color} name={icon} size={20} />
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
        size={20}
      />
    </Pressable>
  );
}

const styles = themed(({ colors, textStyles }) =>
  StyleSheet.create({
    row: {
      minHeight: minimumTouchTarget + 12,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      borderBottomColor: colors.outline,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    icon: {
      width: 36,
      height: 36,
      borderRadius: radius.sm,
      backgroundColor: colors.container,
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
    status: { ...textStyles.label, fontSize: 12, color: colors.primary },
    selected: { backgroundColor: colors.primarySoft },
    disabled: { opacity: 0.5 },
    pressed: { backgroundColor: colors.container },
  }),
);
