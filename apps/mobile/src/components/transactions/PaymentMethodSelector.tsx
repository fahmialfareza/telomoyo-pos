import { useResponsiveStyles } from "@/theme/responsive";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { SelectablePaymentMethod } from "@/domain/types";
import {
  colors,
  minimumTouchTarget,
  radius,
  spacing,
  textStyles,
  typography,
} from "@/theme/tokens";

import { Icon } from "../ui/Icon";
import { ActionGroup } from "../ui/ActionGroup";

const methods: {
  value: SelectablePaymentMethod;
  label: string;
  icon: "cash" | "qrcode-scan";
}[] = [
  { value: "cash", label: "Tunai", icon: "cash" },
  { value: "qris", label: "QRIS", icon: "qrcode-scan" },
];

export function PaymentMethodSelector({
  value,
  onChange,
  qrisDisabled = false,
  qrisDisabledReason,
}: {
  value: SelectablePaymentMethod | null;
  onChange: (method: SelectablePaymentMethod) => void;
  qrisDisabled?: boolean;
  qrisDisabledReason?: string;
}) {
  const responsive = useResponsiveStyles(styles);
  return (
    <View accessibilityLabel="Metode pembayaran" style={responsive.container}>
      <Text style={responsive.label}>METODE PEMBAYARAN</Text>
      <ActionGroup horizontal>
        {methods.map((method) => {
          const selected = value === method.value;
          const disabled = method.value === "qris" && qrisDisabled;

          return (
            <Pressable
              accessibilityLabel={method.label}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected, disabled }}
              disabled={disabled}
              key={method.value}
              onPress={() => onChange(method.value)}
              style={({ pressed }) => [
                responsive.option,
                selected && responsive.optionSelected,
                disabled && responsive.optionDisabled,
                pressed && responsive.pressed,
              ]}
            >
              <Icon
                color={
                  disabled
                    ? colors.textMuted
                    : selected
                      ? colors.onPrimary
                      : colors.primary
                }
                name={method.icon}
                size={20}
              />
              <Text
                style={[
                  responsive.optionText,
                  selected && responsive.selectedText,
                  disabled && responsive.disabledText,
                ]}
              >
                {method.label}
              </Text>
            </Pressable>
          );
        })}
      </ActionGroup>
      {qrisDisabled && qrisDisabledReason ? (
        <Text style={responsive.disabledReason}>{qrisDisabledReason}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.xs },
  label: { ...textStyles.label, color: colors.textMuted, fontSize: 10 },
  option: {
    minHeight: minimumTouchTarget,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.card,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  optionSelected: {
    backgroundColor: colors.primary,
  },
  optionDisabled: {
    borderColor: colors.outline,
    backgroundColor: colors.container,
    opacity: 0.72,
  },
  optionText: {
    flexShrink: 1,
    textAlign: "center",
    fontFamily: typography.bodySemibold,
    fontSize: 14,
    color: colors.primary,
  },
  selectedText: { color: colors.onPrimary },
  disabledText: { color: colors.textMuted },
  disabledReason: {
    ...textStyles.body,
    color: colors.textMuted,
    fontSize: 11,
  },
  pressed: { opacity: 0.82 },
});
