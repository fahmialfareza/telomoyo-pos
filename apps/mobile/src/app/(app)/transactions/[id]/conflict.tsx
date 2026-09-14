import {
  useResponsiveStyles,
  useResponsiveTextStyles,
} from "@/theme/responsive";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { useAuth } from "@/auth/AuthProvider";
import { AppScreen } from "@/components/layout/AppScreen";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { getConflictForTransaction, resolveConflict } from "@/db/repositories";
import type { SyncConflict, Transaction } from "@/domain/types";
import { useSyncRuntime } from "@/sync/SyncProvider";
import { colors, spacing, textStyles, typography } from "@/theme/tokens";
import { displayTransactionId, formatRupiah } from "@/utils/format";

export default function ConflictReviewScreen() {
  const responsive = useResponsiveStyles(styles);
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const sync = useSyncRuntime();
  const [conflict, setConflict] = useState<SyncConflict | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (id && session)
      void getConflictForTransaction(id, session).then((value) => {
        if (active) setConflict(value);
      });
    return () => {
      active = false;
    };
  }, [id, session]);

  const decide = async (resolution: "server" | "retry-local") => {
    if (!conflict || !session) return;
    setBusy(true);
    setError(null);
    try {
      await resolveConflict(conflict, resolution, session);
      await sync.refresh();
      if (resolution === "retry-local") void sync.syncNow();
      router.replace({
        pathname: "/transactions/[id]",
        params: { id: conflict.transactionId },
      });
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Konflik tidak dapat diselesaikan.",
      );
      setConflict(
        await getConflictForTransaction(conflict.transactionId, session),
      );
    } finally {
      setBusy(false);
    }
  };

  if (!conflict) {
    return (
      <AppScreen>
        <PageHeader back title="Tinjau konflik" />
        <Text style={responsive.muted}>
          Konflik sudah diselesaikan atau belum tersedia.
        </Text>
      </AppScreen>
    );
  }

  return (
    <AppScreen>
      <PageHeader
        back
        subtitle={`${displayTransactionId(
          conflict.transactionId,
          session?.dataMode ?? "production",
        )} • Pilih hasil setelah membandingkan kedua versi`}
        title="Konflik Revisi"
      />
      <View style={responsive.columns}>
        <SnapshotCard
          label="VERSI PERANGKAT"
          tone="local"
          transaction={conflict.localSnapshot}
        />
        <SnapshotCard
          label="VERSI SERVER"
          tone="server"
          transaction={conflict.serverSnapshot}
        />
      </View>
      <Card style={responsive.warning}>
        <Text style={responsive.warningTitle}>Keputusan manual diperlukan</Text>
        <Text style={responsive.muted}>
          {conflict.serverSnapshot.deletedAt
            ? "Transaksi sudah dihapus di server. Versi server harus digunakan agar transaksi tidak muncul kembali."
            : "“Kirim ulang lokal” membuat operasi baru dengan base revision server dan tanda tangan baru. Pastikan jumlah lokal memang yang benar."}
        </Text>
      </Card>
      {error ? (
        <Text accessibilityRole="alert" style={responsive.error}>
          {error}
        </Text>
      ) : null}
      {!conflict.serverSnapshot.deletedAt ? (
        <Button loading={busy} onPress={() => void decide("retry-local")}>
          Kirim ulang versi lokal
        </Button>
      ) : null}
      <Button
        disabled={busy}
        onPress={() => void decide("server")}
        variant="secondary"
      >
        Gunakan versi server
      </Button>
    </AppScreen>
  );
}

function SnapshotCard({
  label,
  transaction,
  tone,
}: {
  label: string;
  transaction: Transaction;
  tone: "local" | "server";
}) {
  const responsive = useResponsiveStyles(styles);
  const responsiveText = useResponsiveTextStyles();
  return (
    <Card
      style={[
        responsive.snapshot,
        {
          borderColor: tone === "local" ? colors.warning : colors.secondary,
        },
      ]}
    >
      <Text
        style={[
          responsiveText.label,
          { color: tone === "local" ? colors.warning : colors.secondary },
        ]}
      >
        {label}
      </Text>
      <Text style={responsive.revision}>Revisi #{transaction.revision}</Text>
      {transaction.deletedAt ? (
        <Text style={responsive.deleted}>DIHAPUS DI SERVER</Text>
      ) : null}
      {transaction.items.map((item) => (
        <View key={item.packageId} style={responsive.snapshotLine}>
          <Text style={responsive.itemName}>{item.name}</Text>
          <Text style={responsive.quantity}>× {item.quantity}</Text>
        </View>
      ))}
      <Text style={responsive.amount}>{formatRupiah(transaction.total)}</Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  columns: { gap: spacing.md },
  snapshot: { gap: spacing.sm, borderWidth: 2 },
  revision: {
    fontFamily: typography.heading,
    fontSize: 18,
    color: colors.text,
  },
  snapshotLine: { flexDirection: "row", justifyContent: "space-between" },
  itemName: { ...textStyles.body, flex: 1 },
  quantity: { ...textStyles.body, fontFamily: typography.bodySemibold },
  amount: {
    fontFamily: typography.heading,
    fontSize: 20,
    color: colors.primary,
    textAlign: "right",
  },
  warning: { gap: spacing.xs, backgroundColor: colors.warningSoft },
  warningTitle: { ...textStyles.heading, color: colors.warning },
  muted: { ...textStyles.body, color: colors.textMuted },
  deleted: { ...textStyles.label, color: colors.error },
  error: { ...textStyles.body, color: colors.error },
});
