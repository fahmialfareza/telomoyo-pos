import { useResponsiveStyles } from "@/theme/responsive";
import { StyleSheet, Text, View } from "react-native";

import { paymentMethodLabel } from "@/domain/payments";
import type { PaymentMethod, PaymentStatus } from "@/domain/types";
import { colors, radius, spacing, typography } from "@/theme/tokens";

export function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  const responsive = useResponsiveStyles(styles);
  const tone =
    status === "success"
      ? "success"
      : status === "pending"
        ? "warning"
        : "error";
  const label = {
    pending: "MENUNGGU BAYAR",
    success: "LUNAS",
    failed: "GAGAL BAYAR",
  }[status];

  return (
    <View style={[responsive.badge, styles[`${tone}Background`]]}>
      <View style={[responsive.dot, styles[`${tone}Dot`]]} />
      <Text style={[responsive.text, styles[`${tone}Text`]]}>{label}</Text>
    </View>
  );
}

export function PaymentMethodBadge({ method }: { method: PaymentMethod }) {
  const responsive = useResponsiveStyles(styles);
  return (
    <View style={[responsive.badge, responsive.methodBackground]}>
      <Text style={[responsive.text, responsive.methodText]}>
        {method === "legacy"
          ? "TIDAK TERCATAT"
          : paymentMethodLabel[method].toUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    minHeight: 26,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: radius.pill,
  },
  text: {
    fontFamily: typography.bodySemibold,
    fontSize: 10,
    letterSpacing: 0.25,
  },
  successBackground: { backgroundColor: colors.successSoft },
  successDot: { backgroundColor: colors.success },
  successText: { color: colors.success },
  warningBackground: { backgroundColor: colors.warningSoft },
  warningDot: { backgroundColor: colors.warning },
  warningText: { color: colors.warning },
  errorBackground: { backgroundColor: colors.errorSoft },
  errorDot: { backgroundColor: colors.error },
  errorText: { color: colors.error },
  methodBackground: { backgroundColor: colors.primarySoft },
  methodText: { color: colors.primary },
});
