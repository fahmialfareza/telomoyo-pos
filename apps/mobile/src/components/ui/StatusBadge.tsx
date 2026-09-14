import { useResponsiveStyles } from "@/theme/responsive";
import { StyleSheet, Text, View } from "react-native";

import type { PrintState, SyncState } from "@/domain/types";
import { colors, radius, spacing, typography } from "@/theme/tokens";

type BadgeKind = SyncState | PrintState | "online" | "offline" | "active";

const label: Record<BadgeKind, string> = {
  pending: "MENUNGGU",
  synced: "TERSINKRON",
  conflict: "KONFLIK",
  error: "ERROR",
  success: "TERCETAK",
  failed: "GAGAL CETAK",
  unknown: "HASIL TAK PASTI",
  "needs-reprint": "PERLU CETAK ULANG",
  online: "ONLINE",
  offline: "OFFLINE",
  active: "AKTIF",
};

export function StatusBadge({ kind }: { kind: BadgeKind }) {
  const responsive = useResponsiveStyles(styles);
  const tone =
    kind === "synced" ||
    kind === "success" ||
    kind === "online" ||
    kind === "active"
      ? "success"
      : kind === "pending" || kind === "unknown" || kind === "needs-reprint"
        ? "warning"
        : "error";

  return (
    <View style={[responsive.badge, styles[`${tone}Background`]]}>
      <View style={[responsive.dot, styles[`${tone}Dot`]]} />
      <Text style={[responsive.text, styles[`${tone}Text`]]}>
        {label[kind]}
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
});
