import { ActivityIndicator, Pressable, StyleSheet } from "react-native";

import { colors, minimumTouchTarget, radius } from "@/theme/tokens";
import { Icon, type IconName } from "./Icon";

/** Compact visual action with a full-size accessible touch target. */
export function IconButton({
  icon,
  label,
  onPress,
  disabled = false,
  loading = false,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  const blocked = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: blocked, busy: loading }}
      disabled={blocked}
      onPress={blocked ? undefined : onPress}
      style={({ pressed }) => [
        styles.button,
        pressed && styles.pressed,
        blocked && styles.disabled,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={colors.primary} />
      ) : (
        <Icon name={icon} color={colors.primary} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: minimumTouchTarget,
    height: minimumTouchTarget,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.outline,
    borderRadius: radius.md,
  },
  pressed: { backgroundColor: colors.primarySoft },
  disabled: { opacity: 0.5 },
});
