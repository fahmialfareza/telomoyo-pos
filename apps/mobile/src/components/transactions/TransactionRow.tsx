import { useResponsiveStyles } from "@/theme/responsive";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { DataMode, Transaction } from "@/domain/types";
import {
  colors,
  radius,
  spacing,
  textStyles,
  typography,
} from "@/theme/tokens";
import {
  compactTransactionId,
  formatJakartaDateTime,
  formatRupiah,
} from "@/utils/format";

import { StatusBadge } from "../ui/StatusBadge";
import { PaymentMethodBadge, PaymentStatusBadge } from "../ui/PaymentBadge";

export function TransactionRow({
  transaction,
  onPress,
  dataMode = "production",
}: {
  transaction: Transaction;
  onPress: () => void;
  dataMode?: DataMode;
}) {
  const responsive = useResponsiveStyles(styles);
  const accentToken = transaction.items[0]?.accent ?? "primary";
  const accent =
    accentToken === "sunrise"
      ? colors.sunrise
      : accentToken === "standard"
        ? colors.standard
        : colors.primary;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [responsive.card, pressed && responsive.pressed]}
    >
      <View style={[responsive.accent, { backgroundColor: accent }]} />
      <View style={responsive.content}>
        <View style={responsive.top}>
          <View style={responsive.flex}>
            <Text style={responsive.id}>
              {compactTransactionId(transaction.id, dataMode)}
            </Text>
            <Text numberOfLines={1} style={responsive.name}>
              {transaction.items.map((item) => item.name).join(" + ")}
            </Text>
          </View>
          <Text style={responsive.amount}>
            {formatRupiah(transaction.total)}
          </Text>
        </View>
        <View style={responsive.meta}>
          <Text style={responsive.muted}>
            {formatJakartaDateTime(transaction.occurredAt)}
          </Text>
          <Text style={responsive.muted}>
            {transaction.items.reduce((sum, item) => sum + item.quantity, 0)}{" "}
            item
          </Text>
        </View>
        <View style={responsive.bottom}>
          <Text numberOfLines={1} style={responsive.actor}>
            {transaction.updatedActorName}
          </Text>
          <View style={responsive.badges}>
            <StatusBadge kind={transaction.syncState} />
            <PaymentMethodBadge method={transaction.paymentMethod} />
            <PaymentStatusBadge status={transaction.paymentStatus} />
          </View>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderColor: colors.outline,
    borderWidth: 1,
    borderRadius: radius.lg,
    flexDirection: "row",
    overflow: "hidden",
  },
  accent: { width: 5 },
  content: { flex: 1, padding: spacing.md, gap: spacing.sm },
  top: { flexDirection: "row", gap: spacing.sm },
  flex: { flex: 1 },
  id: textStyles.technical,
  name: {
    fontFamily: typography.headingSemibold,
    fontSize: 16,
    color: colors.text,
    marginTop: 2,
  },
  amount: {
    fontFamily: typography.heading,
    fontSize: 16,
    color: colors.primary,
  },
  meta: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  muted: { ...textStyles.body, color: colors.textMuted, fontSize: 12 },
  bottom: {
    paddingTop: spacing.sm,
    borderTopColor: colors.outline,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  actor: { ...textStyles.body, flex: 1, color: colors.textMuted },
  badges: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: spacing.xs,
    flexWrap: "wrap",
  },
  pressed: { opacity: 0.82 },
});
