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
}: {
  icon: IconName;
  title: string;
  detail?: string;
  onPress: () => void;
  destructive?: boolean;
}) {
  const responsive = useResponsiveStyles(styles);
  const color = destructive ? colors.error : colors.primary;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [responsive.row, pressed && responsive.pressed]}
    >
      <View style={responsive.icon}>
        <Icon color={color} name={icon} />
      </View>
      <View style={responsive.copy}>
        <Text style={[responsive.title, destructive && { color }]}>
          {title}
        </Text>
        {detail ? <Text style={responsive.detail}>{detail}</Text> : null}
      </View>
      <Icon color={colors.outline} name="chevron-right" />
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
  copy: { flex: 1 },
  title: {
    fontFamily: typography.bodyMedium,
    fontSize: 15,
    color: colors.text,
  },
  detail: { ...textStyles.body, color: colors.textMuted, fontSize: 12 },
  pressed: { backgroundColor: colors.surface },
});
