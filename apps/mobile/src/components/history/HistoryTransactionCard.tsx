import { useResponsiveStyles } from "@/theme/responsive";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type {
  DataMode,
  PrintState,
  SyncState,
  Transaction,
} from "@/domain/types";
import { paymentMethodLabel, paymentStatusLabel } from "@/domain/payments";
import {
  colors,
  minimumTouchTarget,
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

import { Icon } from "../ui/Icon";
import { PaymentMethodBadge, PaymentStatusBadge } from "../ui/PaymentBadge";
import { StatusBadge } from "../ui/StatusBadge";

const syncStateLabel: Record<SyncState, string> = {
  pending: "menunggu sinkronisasi",
  synced: "tersinkron",
  conflict: "konflik",
  error: "gagal disinkronkan",
};

const printStateLabel: Record<PrintState, string> = {
  pending: "belum dicetak",
  success: "tercetak",
  failed: "gagal dicetak",
  unknown: "hasil cetak tidak diketahui",
  "needs-reprint": "perlu dicetak ulang",
};

export function HistoryTransactionCard({
  transaction,
  onPress,
  dataMode = "production",
}: {
  transaction: Transaction;
  onPress: () => void;
  dataMode?: DataMode;
}) {
  const responsive = useResponsiveStyles(styles);
  const transactionId = compactTransactionId(transaction.id, dataMode);
  const itemQuantity = transaction.items.reduce(
    (sum, item) => sum + item.quantity,
    0,
  );
  const packageNames = transaction.items.map((item) => item.name).join(" + ");
  const accentToken = transaction.items[0]?.accent ?? "primary";
  const accent =
    accentToken === "sunrise"
      ? colors.sunrise
      : accentToken === "standard"
        ? colors.standard
        : colors.primary;
  const accessibilityLabel = [
    `Buka transaksi ${transactionId}`,
    packageNames,
    formatRupiah(transaction.total),
    formatJakartaDateTime(transaction.occurredAt),
    `${itemQuantity} item`,
    `dibuat oleh ${transaction.updatedActorName}`,
    paymentMethodLabel[transaction.paymentMethod],
    paymentStatusLabel[transaction.paymentStatus],
    syncStateLabel[transaction.syncState],
    printStateLabel[transaction.printState],
  ].join(", ");

  return (
    <Pressable
      accessibilityHint="Membuka detail transaksi"
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [responsive.card, pressed && responsive.pressed]}
    >
      <View style={[responsive.accent, { backgroundColor: accent }]} />
      <View style={responsive.content}>
        <View style={responsive.header}>
          <Text numberOfLines={1} style={responsive.id}>
            {transactionId}
          </Text>
          <StatusBadge kind={transaction.syncState} />
        </View>

        <View style={responsive.summary}>
          <View style={responsive.summaryCopy}>
            <Text numberOfLines={1} style={responsive.packageNames}>
              {packageNames}
            </Text>
            <Text style={responsive.date}>
              {formatJakartaDateTime(transaction.occurredAt)} · {itemQuantity}{" "}
              item
            </Text>
          </View>
          <Text numberOfLines={1} style={responsive.amount}>
            {formatRupiah(transaction.total)}
          </Text>
        </View>

        <View style={responsive.footer}>
          <View style={responsive.actor}>
            <Icon color={colors.textMuted} name="account-outline" size={18} />
            <Text numberOfLines={1} style={responsive.actorName}>
              {transaction.updatedActorName}
            </Text>
          </View>
          <PaymentMethodBadge method={transaction.paymentMethod} />
          <PaymentStatusBadge status={transaction.paymentStatus} />
          <View style={responsive.chevron}>
            <Icon color={colors.primary} name="chevron-right" size={22} />
          </View>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    minHeight: minimumTouchTarget,
    backgroundColor: colors.card,
    borderColor: colors.outline,
    borderWidth: 1,
    borderRadius: radius.lg,
    flexDirection: "row",
    overflow: "hidden",
  },
  accent: {
    width: 4,
  },
  content: {
    flex: 1,
    padding: spacing.md,
    gap: spacing.sm,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  id: {
    ...textStyles.technical,
    color: colors.textMuted,
    flex: 1,
  },
  summary: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.md,
  },
  summaryCopy: {
    flex: 1,
    gap: 2,
  },
  packageNames: {
    fontFamily: typography.headingSemibold,
    fontSize: 16,
    lineHeight: 22,
    color: colors.text,
  },
  date: {
    ...textStyles.body,
    color: colors.textMuted,
    fontSize: 12,
  },
  amount: {
    fontFamily: typography.heading,
    fontSize: 17,
    lineHeight: 22,
    color: colors.primary,
    textAlign: "right",
  },
  footer: {
    minHeight: 28,
    paddingTop: spacing.sm,
    borderTopColor: colors.outline,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  actor: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  actorName: {
    ...textStyles.body,
    color: colors.textMuted,
    flexShrink: 1,
  },
  chevron: {
    width: 24,
    alignItems: "flex-end",
  },
  pressed: {
    backgroundColor: colors.surfaceBright,
    opacity: 0.86,
  },
});
