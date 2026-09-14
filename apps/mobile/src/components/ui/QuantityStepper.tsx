import { useResponsiveStyles } from "@/theme/responsive";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { colors, minimumTouchTarget, radius, typography } from "@/theme/tokens";

import { Icon } from "./Icon";

interface QuantityStepperProps {
  value: number;
  onChange: (value: number) => void;
  maximum?: number;
}

export function QuantityStepper({
  value,
  onChange,
  maximum = 999,
}: QuantityStepperProps) {
  const responsive = useResponsiveStyles(styles);
  return (
    <View style={responsive.wrapper}>
      <Pressable
        accessibilityLabel="Kurangi jumlah"
        accessibilityRole="button"
        disabled={value === 0}
        hitSlop={4}
        onPress={() => onChange(Math.max(0, value - 1))}
        style={({ pressed }) => [
          responsive.control,
          pressed && responsive.pressed,
          value === 0 && responsive.disabled,
        ]}
      >
        <Icon color={colors.textMuted} name="minus" />
      </Pressable>
      <Text accessibilityLiveRegion="polite" style={responsive.value}>
        {value}
      </Text>
      <Pressable
        accessibilityLabel="Tambah jumlah"
        accessibilityRole="button"
        disabled={value >= maximum}
        hitSlop={4}
        onPress={() => onChange(Math.min(maximum, value + 1))}
        style={({ pressed }) => [
          responsive.control,
          pressed && responsive.pressed,
          value >= maximum && responsive.disabled,
        ]}
      >
        <Icon color={colors.primary} name="plus" />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    minHeight: minimumTouchTarget,
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.outline,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceBright,
    overflow: "hidden",
  },
  control: {
    width: minimumTouchTarget,
    height: minimumTouchTarget,
    alignItems: "center",
    justifyContent: "center",
  },
  value: {
    minWidth: 34,
    textAlign: "center",
    fontFamily: typography.heading,
    color: colors.text,
    fontSize: 18,
  },
  pressed: { backgroundColor: colors.containerHigh },
  disabled: { opacity: 0.35 },
});
