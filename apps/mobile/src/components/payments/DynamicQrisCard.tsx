import { useResponsiveStyles } from "@/theme/responsive";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import QRCode from "react-native-qrcode-svg";

import { formatRupiah } from "@/utils/format";
import {
  colors,
  radius,
  spacing,
  textStyles,
  typography,
} from "@/theme/tokens";

import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Icon } from "../ui/Icon";

interface DynamicQrisCardProps {
  amount: number;
  orderTotal?: number;
  sandbox?: boolean;
  merchantName: string | null;
  merchantCity: string | null;
  payload: string | null;
  error: string | null;
  onConfigure?: () => void;
}

export function DynamicQrisCard({
  amount,
  orderTotal,
  sandbox = false,
  merchantName,
  merchantCity,
  payload,
  error,
  onConfigure,
}: DynamicQrisCardProps) {
  const responsive = useResponsiveStyles(styles);
  const [qrWidth, setQrWidth] = useState(304);
  if (!payload || !merchantName || !merchantCity) {
    return (
      <Card style={responsive.unavailable}>
        <View style={responsive.header}>
          <View style={responsive.warningIcon}>
            <Icon color={colors.warning} name="qrcode-remove" size={24} />
          </View>
          <View style={responsive.headerCopy}>
            <Text style={responsive.eyebrow}>QRIS NOMINAL OTOMATIS</Text>
            <Text style={responsive.title}>Kode pembayaran belum tersedia</Text>
          </View>
        </View>
        <Text accessibilityRole="alert" style={responsive.guidance}>
          {error ?? "QRIS merchant belum dikonfigurasi pada perangkat ini."}
        </Text>
        {onConfigure ? (
          <Button icon="cog-outline" onPress={onConfigure} variant="secondary">
            Atur QRIS merchant
          </Button>
        ) : null}
      </Card>
    );
  }

  const formattedAmount = formatRupiah(amount);

  return (
    <Card style={responsive.ready}>
      {sandbox ? (
        <View accessibilityRole="alert" style={responsive.sandboxNotice}>
          <Text style={responsive.sandboxNoticeTitle}>QRIS UJI NYATA</Text>
          <Text style={responsive.sandboxNoticeText}>
            {formattedAmount} akan masuk ke rekening merchant.
          </Text>
        </View>
      ) : null}
      <View style={responsive.header}>
        <View style={responsive.readyIcon}>
          <Icon color={colors.primary} name="qrcode-scan" size={24} />
        </View>
        <View style={responsive.headerCopy}>
          <Text style={responsive.eyebrow}>QRIS NOMINAL OTOMATIS</Text>
          <Text style={responsive.title}>Pindai untuk membayar</Text>
        </View>
      </View>
      <View
        accessibilityLabel={`QRIS pembayaran ${formattedAmount} untuk ${merchantName}`}
        accessibilityRole="image"
        style={responsive.qrFrame}
        onLayout={(event) => setQrWidth(event.nativeEvent.layout.width)}
      >
        <QRCode
          backgroundColor="#FFFFFF"
          color="#000000"
          ecl="M"
          quietZone={32}
          size={Math.max(128, Math.min(240, qrWidth - 64))}
          value={payload}
        />
      </View>
      <View style={responsive.amountBlock}>
        <Text style={responsive.amountLabel}>
          {sandbox ? "NOMINAL QRIS NYATA" : "TOTAL PEMBAYARAN"}
        </Text>
        <Text style={responsive.amount}>{formattedAmount}</Text>
        {sandbox && orderTotal !== undefined ? (
          <Text style={responsive.orderTotal}>
            Total simulasi paket: {formatRupiah(orderTotal)}
          </Text>
        ) : null}
      </View>
      <View style={responsive.merchant}>
        <Text style={responsive.merchantName}>{merchantName}</Text>
        <Text style={responsive.merchantCity}>{merchantCity}</Text>
      </View>
      <Text style={responsive.guidance}>
        Cocokkan nama merchant dan nominal di aplikasi pembayaran. Konfirmasi
        berhasil hanya setelah notifikasi diterima merchant.
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  ready: {
    gap: spacing.md,
    alignItems: "stretch",
    borderColor: colors.primary,
    backgroundColor: colors.surfaceBright,
  },
  unavailable: {
    gap: spacing.md,
    backgroundColor: colors.warningSoft,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  headerCopy: { flex: 1 },
  readyIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primarySoft,
  },
  warningIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.card,
  },
  eyebrow: { ...textStyles.label, color: colors.primary, fontSize: 10 },
  title: { ...textStyles.heading, marginTop: 2 },
  qrFrame: {
    alignSelf: "center",
    alignItems: "center",
    width: "100%",
    borderRadius: radius.lg,
    backgroundColor: colors.card,
  },
  amountBlock: { alignItems: "center", gap: spacing.xs },
  amountLabel: { ...textStyles.label, fontSize: 10 },
  amount: {
    fontFamily: typography.price,
    fontSize: 28,
    lineHeight: 36,
    color: colors.primary,
  },
  merchant: {
    alignItems: "center",
    gap: 2,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.outline,
  },
  merchantName: {
    fontFamily: typography.headingSemibold,
    fontSize: 16,
    color: colors.text,
    textAlign: "center",
  },
  merchantCity: {
    ...textStyles.body,
    color: colors.textMuted,
    textAlign: "center",
  },
  guidance: {
    ...textStyles.body,
    color: colors.textMuted,
    textAlign: "center",
    fontSize: 12,
  },
  sandboxNotice: {
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.warningSoft,
    borderWidth: 1,
    borderColor: colors.warning,
    alignItems: "center",
  },
  sandboxNoticeTitle: {
    ...textStyles.label,
    color: colors.warning,
    fontSize: 11,
  },
  sandboxNoticeText: {
    ...textStyles.body,
    color: colors.warning,
    textAlign: "center",
  },
  orderTotal: { ...textStyles.body, color: colors.textMuted, fontSize: 12 },
});
