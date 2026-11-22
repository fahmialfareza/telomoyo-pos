import { useResponsiveStyles, themed } from "@/theme/responsive";
import { useThemeColors } from "@/theme/ThemeContext";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";

import { useSyncRuntime } from "@/sync/SyncProvider";
import { spacing, typography } from "@/theme/tokens";

import { Icon } from "../ui/Icon";

export function SyncBar() {
  const colors = useThemeColors();
  const responsive = useResponsiveStyles(styles);
  const router = useRouter();
  const { online, pendingCount, syncing, lastSyncedAt } = useSyncRuntime();

  const label = online
    ? pendingCount > 0
      ? `${pendingCount} perubahan menunggu`
      : lastSyncedAt
        ? `Sinkron ${relativeTime(lastSyncedAt)}`
        : "Siap sinkron"
    : "Offline — data tetap tersimpan";

  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push("/sync")}
      style={({ pressed }) => [
        responsive.bar,
        !online && responsive.offline,
        pressed && responsive.pressed,
      ]}
    >
      <View style={responsive.left}>
        <View
          style={[
            responsive.dot,
            online ? responsive.dotOnline : responsive.dotOffline,
          ]}
        />
        <Text style={responsive.text}>{online ? "Online" : "Offline"}</Text>
      </View>
      <View style={responsive.right}>
        <Text style={responsive.detail}>{label}</Text>
        <Icon
          color={colors.textMuted}
          name={syncing ? "sync" : "chevron-right"}
          size={16}
        />
      </View>
    </Pressable>
  );
}

function relativeTime(iso: string): string {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - new Date(iso).getTime()) / 60_000),
  );
  if (minutes < 1) return "baru saja";
  if (minutes < 60) return `${minutes} mnt lalu`;
  return `${Math.floor(minutes / 60)} jam lalu`;
}

const styles = themed(({ colors }) =>
  StyleSheet.create({
    bar: {
      minHeight: 40,
      paddingVertical: spacing.xs,
      paddingHorizontal: spacing.md,
      backgroundColor: colors.surface,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.outline,
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      gap: spacing.sm,
    },
    offline: {
      backgroundColor: colors.warningSoft,
    },
    pressed: {
      backgroundColor: colors.container,
    },
    left: {
      flexShrink: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    right: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "flex-end",
      gap: 2,
    },
    dot: { width: 8, height: 8, borderRadius: 4 },
    dotOnline: { backgroundColor: colors.success },
    dotOffline: { backgroundColor: colors.warning },
    text: {
      color: colors.text,
      fontFamily: typography.bodyMedium,
      fontSize: 12,
    },
    detail: {
      color: colors.textMuted,
      fontFamily: typography.body,
      fontSize: 12,
      maxWidth: "80%",
    },
  }),
);
