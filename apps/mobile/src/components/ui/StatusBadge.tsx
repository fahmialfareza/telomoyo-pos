import {
  useResponsiveStyles,
  themed,
  useThemedStyles,
} from "@/theme/responsive";
import { StyleSheet, Text, View } from "react-native";

import type { PrintState, SyncState } from "@/domain/types";
import { radius, spacing, typography } from "@/theme/tokens";

type BadgeKind = SyncState | PrintState | "online" | "offline" | "active";

const label: Record<BadgeKind, string> = {
  pending: "Menunggu",
  synced: "Tersinkron",
  conflict: "Konflik",
  error: "Error",
  success: "Tercetak",
  failed: "Gagal cetak",
  unknown: "Hasil tak pasti",
  "needs-reprint": "Perlu cetak ulang",
  online: "Online",
  offline: "Offline",
  active: "Aktif",
};

export function StatusBadge({ kind }: { kind: BadgeKind }) {
  const responsive = useResponsiveStyles(styles);
  const raw = useThemedStyles(styles);
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
    <View style={[responsive.badge, raw[`${tone}Background`]]}>
      <View style={[responsive.dot, raw[`${tone}Dot`]]} />
      <Text style={[responsive.text, raw[`${tone}Text`]]}>{label[kind]}</Text>
    </View>
  );
}

const styles = themed(({ colors }) =>
  StyleSheet.create({
    badge: {
      minHeight: 24,
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
      fontFamily: typography.bodyMedium,
      fontSize: 12,
      lineHeight: 16,
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
  }),
);
