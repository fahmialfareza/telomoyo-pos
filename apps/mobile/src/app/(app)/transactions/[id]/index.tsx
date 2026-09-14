import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { useAuth } from "@/auth/AuthProvider";
import { AppScreen } from "@/components/layout/AppScreen";
import { PageHeader } from "@/components/layout/PageHeader";
import { DynamicQrisCard } from "@/components/payments/DynamicQrisCard";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ActionGroup } from "@/components/ui/ActionGroup";
import { useConfirmation } from "@/components/ui/ConfirmationProvider";
import {
  PaymentMethodBadge,
  PaymentStatusBadge,
} from "@/components/ui/PaymentBadge";
import { StateView } from "@/components/ui/StateView";
import { StatusBadge } from "@/components/ui/StatusBadge";
import {
  getTransaction,
  hasTerminalTransactionBlock,
  setPaymentStatus,
} from "@/db/repositories";
import {
  canCorrectTransaction,
  canManageTransactionPayment,
} from "@/domain/permissions";
import { isPaymentConfirmedForCurrentRevision } from "@/domain/payments";
import {
  createDynamicQris,
  fingerprintStaticQris,
  validateStaticQris,
} from "@/domain/qris";
import type { PaymentStatus, Transaction } from "@/domain/types";
import { readQrisConfig, type QrisConfig } from "@/security/secure-store";
import { qrisPayloadForTransaction } from "@/tenant/configuration";
import { useSyncRuntime } from "@/sync/SyncProvider";
import { colors, spacing, textStyles, typography } from "@/theme/tokens";
import {
  useResponsiveStyles,
  useResponsiveTextStyles,
} from "@/theme/responsive";
import {
  displayTransactionId,
  formatJakartaDateTime,
  formatRupiah,
} from "@/utils/format";

interface QrisPresentation {
  payload: string | null;
  merchantName: string | null;
  merchantCity: string | null;
  error: string | null;
  canConfigure: boolean;
}

export default function TransactionDetailScreen() {
  const styles = useResponsiveStyles(baseStyles);
  const textStyles = useResponsiveTextStyles();
  const { confirm } = useConfirmation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const sync = useSyncRuntime();
  const lastSyncCompletedAt = sync.lastSummary?.completedAt ?? null;
  const [transaction, setTransaction] = useState<Transaction | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [paymentUpdating, setPaymentUpdating] = useState<PaymentStatus | null>(
    null,
  );
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [terminalBlocked, setTerminalBlocked] = useState(false);
  const [qrisConfig, setQrisConfig] = useState<QrisConfig | null>(null);
  const [qrisConfigFingerprint, setQrisConfigFingerprint] = useState<
    string | null
  >(null);
  const [qrisConfigError, setQrisConfigError] = useState<string | null>(null);
  const loadRequestId = useRef(0);
  const focusedRef = useRef(false);
  const lastObservedSyncRef = useRef(lastSyncCompletedAt);

  const load = useCallback(async () => {
    if (!id || !session) return;
    const currentRequestId = ++loadRequestId.current;
    const qrisConfigPromise = readQrisConfig(session.tenantId ?? undefined)
      .then(async (config) => ({
        config,
        fingerprint: config
          ? await fingerprintStaticQris(config.staticPayload)
          : null,
        error: null,
      }))
      .catch((reason: unknown) => ({
        config: null,
        fingerprint: null,
        error:
          reason instanceof Error
            ? reason.message
            : "Konfigurasi QRIS tidak dapat dibaca.",
      }));
    try {
      const [nextTransaction, nextTerminalBlocked, nextQrisConfig] =
        await Promise.all([
          getTransaction(id, session),
          hasTerminalTransactionBlock(id),
          qrisConfigPromise,
        ]);
      if (currentRequestId !== loadRequestId.current) return;
      // Prefer the exact historical merchant version, never another active QR.
      if (nextTransaction?.qrisPayloadHash) {
        const historical = await qrisPayloadForTransaction(
          nextTransaction.qrisPayloadHash,
          session,
        );
        if (currentRequestId !== loadRequestId.current) return;
        if (historical) {
          nextQrisConfig.config = { staticPayload: historical };
          nextQrisConfig.fingerprint = await fingerprintStaticQris(historical);
        }
      }
      setTransaction(nextTransaction);
      setTerminalBlocked(nextTerminalBlocked);
      setQrisConfig(nextQrisConfig.config);
      setQrisConfigFingerprint(nextQrisConfig.fingerprint);
      setQrisConfigError(nextQrisConfig.error);
      setLoadError(null);
      setLoaded(true);
    } catch (reason) {
      if (currentRequestId !== loadRequestId.current) return;
      const message =
        reason instanceof Error
          ? reason.message
          : "Transaksi tidak dapat dimuat ulang.";
      // Keep an already-rendered receipt visible, but fail closed for QR,
      // payment, and printing until local state can be read reliably again.
      setTerminalBlocked(true);
      setQrisConfig(null);
      setQrisConfigFingerprint(null);
      setQrisConfigError(message);
      setLoadError(message);
      setLoaded(true);
    }
  }, [id, session]);

  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      void load();
      return () => {
        focusedRef.current = false;
        loadRequestId.current += 1;
      };
    }, [load]),
  );

  useEffect(() => {
    const previous = lastObservedSyncRef.current;
    lastObservedSyncRef.current = lastSyncCompletedAt;
    if (
      focusedRef.current &&
      lastSyncCompletedAt !== null &&
      lastSyncCompletedAt !== previous
    ) {
      void load();
    }
  }, [lastSyncCompletedAt, load]);

  const qrisPresentation = useMemo<QrisPresentation | null>(() => {
    if (!transaction || transaction.paymentMethod !== "qris") return null;
    if (!transaction.qrisPayloadHash) {
      return {
        payload: null,
        merchantName: null,
        merchantCity: null,
        error:
          "Transaksi QRIS lama ini tidak memiliki fingerprint merchant. Kode pembayaran tidak dapat dibuat ulang dengan aman; lakukan rekonsiliasi pembayaran secara manual.",
        canConfigure: false,
      };
    }
    if (!qrisConfig) {
      return {
        payload: null,
        merchantName: null,
        merchantCity: null,
        error:
          qrisConfigError ??
          "QRIS merchant belum dikonfigurasi pada perangkat ini.",
        canConfigure: true,
      };
    }
    if (qrisConfigFingerprint !== transaction.qrisPayloadHash) {
      return {
        payload: null,
        merchantName: null,
        merchantCity: null,
        error:
          "QRIS merchant pada perangkat ini berbeda dari QRIS yang terikat ke transaksi. Pulihkan konfigurasi merchant yang sama; kode pembayaran tidak dibuat untuk mencegah pembayaran ke merchant lain.",
        canConfigure: true,
      };
    }

    let merchant;
    try {
      merchant = validateStaticQris(qrisConfig.staticPayload);
    } catch (reason) {
      return {
        payload: null,
        merchantName: null,
        merchantCity: null,
        error:
          reason instanceof Error
            ? reason.message
            : "Konfigurasi QRIS merchant tidak valid.",
        canConfigure: true,
      };
    }

    try {
      const dynamic = createDynamicQris(
        qrisConfig.staticPayload,
        transaction.paymentAmount,
      );
      return {
        payload: dynamic.payload,
        merchantName: dynamic.merchantName,
        merchantCity: dynamic.merchantCity,
        error: null,
        canConfigure: false,
      };
    } catch (reason) {
      return {
        payload: null,
        merchantName: merchant.merchantName,
        merchantCity: merchant.merchantCity,
        error:
          reason instanceof Error
            ? reason.message
            : "QRIS nominal otomatis tidak dapat dibuat.",
        canConfigure: false,
      };
    }
  }, [qrisConfig, qrisConfigError, qrisConfigFingerprint, transaction]);

  if (loaded && !transaction) {
    return (
      <AppScreen>
        <PageHeader back title="Detail transaksi" />
        <StateView
          icon="receipt-text-remove-outline"
          message={
            loadError ??
            "Data mungkin telah dihapus di server dan tombstone sudah diterima."
          }
          title={
            loadError
              ? "Transaksi tidak dapat dimuat"
              : "Transaksi tidak ditemukan"
          }
        />
      </AppScreen>
    );
  }
  if (!transaction) return <AppScreen />;

  const hasUnresolvedConflict = transaction.syncState === "conflict";
  const archived = transaction.deletedAt !== null;
  const mayCorrect =
    !hasUnresolvedConflict &&
    !terminalBlocked &&
    !archived &&
    canCorrectTransaction(session, transaction);
  const mayManagePayment =
    !hasUnresolvedConflict &&
    !terminalBlocked &&
    !archived &&
    canManageTransactionPayment(session, transaction);
  const paymentConfirmed =
    !hasUnresolvedConflict &&
    !terminalBlocked &&
    !archived &&
    isPaymentConfirmedForCurrentRevision(transaction);

  const updatePayment = async (status: Exclude<PaymentStatus, "pending">) => {
    if (!session || !mayManagePayment) return;
    setPaymentUpdating(status);
    setPaymentError(null);
    try {
      setTransaction(await setPaymentStatus(transaction.id, status, session));
      await sync.refresh();
      void sync.syncNow();
    } catch (reason) {
      setPaymentError(
        reason instanceof Error
          ? reason.message
          : "Status pembayaran tidak dapat diperbarui.",
      );
    } finally {
      setPaymentUpdating(null);
    }
  };

  const confirmPayment = (status: Exclude<PaymentStatus, "pending">) => {
    const successMessage =
      transaction.paymentMethod === "cash"
        ? "Pastikan uang tunai sudah diterima penuh. Status berhasil akan final untuk revisi transaksi ini."
        : transaction.paymentMethod === "qris"
          ? "Pastikan aplikasi penyedia atau bank menampilkan pembayaran berhasil. Status berhasil akan final untuk revisi transaksi ini."
          : "Pastikan pembayaran sudah diterima. Status berhasil akan final untuk revisi transaksi ini.";
    confirm({
      title:
        status === "success"
          ? "Konfirmasi pembayaran berhasil?"
          : "Tandai pembayaran gagal?",
      message:
        status === "success"
          ? successMessage
          : "Transaksi tetap tersimpan, tidak dihitung sebagai pendapatan, dan tidak dapat dicetak sampai pembayaran berhasil.",
      confirmLabel:
        status === "success" ? "Ya, pembayaran berhasil" : "Tandai gagal",
      destructive: status === "failed",
      onConfirm: () => updatePayment(status),
    });
  };

  return (
    <AppScreen
      stickyFooter={
        mayCorrect || mayManagePayment || paymentConfirmed || paymentError ? (
          <ActionGroup>
            {mayCorrect ? (
              <Button
                disabled={paymentUpdating !== null}
                icon="pencil-outline"
                onPress={() =>
                  router.push({
                    pathname: "/transactions/[id]/correct",
                    params: { id: transaction.id },
                  })
                }
                variant="secondary"
              >
                Koreksi transaksi
              </Button>
            ) : null}
            {mayManagePayment && !paymentConfirmed ? (
              <ActionGroup>
                <Button
                  disabled={paymentUpdating !== null}
                  icon="check-circle-outline"
                  loading={paymentUpdating === "success"}
                  onPress={() => confirmPayment("success")}
                >
                  Pembayaran berhasil
                </Button>
                {transaction.paymentStatus !== "failed" ? (
                  <Button
                    disabled={paymentUpdating !== null}
                    icon="close-circle-outline"
                    loading={paymentUpdating === "failed"}
                    onPress={() => confirmPayment("failed")}
                    variant="danger"
                  >
                    Pembayaran gagal
                  </Button>
                ) : null}
              </ActionGroup>
            ) : null}
            {paymentError ? (
              <Text accessibilityRole="alert" style={styles.paymentError}>
                {paymentError}
              </Text>
            ) : null}
            {paymentConfirmed ? (
              <Button
                icon="printer-outline"
                onPress={() =>
                  router.push({
                    pathname: "/transactions/[id]/print",
                    params: { id: transaction.id },
                  })
                }
              >
                {transaction.printState === "success" ||
                transaction.printState === "unknown" ||
                transaction.printState === "needs-reprint"
                  ? "Cetak salinan"
                  : "Cetak struk"}
              </Button>
            ) : null}
          </ActionGroup>
        ) : undefined
      }
    >
      <PageHeader
        back
        subtitle={formatJakartaDateTime(transaction.occurredAt)}
        title={displayTransactionId(
          transaction.id,
          session?.dataMode ?? "production",
        )}
      />
      <View style={styles.badges}>
        <StatusBadge kind={transaction.syncState} />
        <PaymentMethodBadge method={transaction.paymentMethod} />
        <PaymentStatusBadge status={transaction.paymentStatus} />
        {transaction.printState !== "pending" ? (
          <StatusBadge kind={transaction.printState} />
        ) : null}
      </View>
      {transaction.syncState === "conflict" ? (
        <Card style={styles.conflict}>
          <Text style={styles.conflictTitle}>Koreksi perlu ditinjau</Text>
          <Text style={styles.muted}>
            Versi server berubah sebelum koreksi perangkat ini diterima.
          </Text>
          <Button
            onPress={() =>
              router.push({
                pathname: "/transactions/[id]/conflict",
                params: { id: transaction.id },
              })
            }
            variant="secondary"
          >
            Bandingkan versi
          </Button>
        </Card>
      ) : null}
      {terminalBlocked ? (
        <Card style={styles.syncBlocked}>
          <Text style={styles.syncBlockedTitle}>
            Transaksi dikunci oleh server
          </Text>
          <Text style={styles.muted}>
            Operasi terminal ditolak. Pulihkan data dari Pusat Sinkron sebelum
            mengoreksi pembayaran atau mencetak.
          </Text>
        </Card>
      ) : null}
      {archived ? (
        <Card style={styles.syncBlocked}>
          <Text style={styles.syncBlockedTitle}>Transaksi diarsipkan</Text>
          <Text style={styles.muted}>
            Transaksi lokal ini tidak diterima server dan tidak dapat diubah,
            dibayar, atau dicetak.
          </Text>
        </Card>
      ) : null}

      {mayManagePayment &&
      !paymentConfirmed &&
      transaction.paymentMethod === "qris" &&
      qrisPresentation ? (
        <DynamicQrisCard
          amount={transaction.paymentAmount}
          error={qrisPresentation.error}
          merchantCity={qrisPresentation.merchantCity}
          merchantName={qrisPresentation.merchantName}
          {...(qrisPresentation.canConfigure &&
          session?.user.role === "superadmin" &&
          session.dataMode === "production"
            ? {
                onConfigure: () => router.push("/settings/qris"),
              }
            : {})}
          payload={qrisPresentation.payload}
          orderTotal={transaction.total}
          sandbox={session?.dataMode === "sandbox"}
        />
      ) : null}

      <Card style={styles.receipt} testID="transaction-summary-card">
        <View style={styles.metaRow}>
          <View>
            <Text style={textStyles.label}>KASIR ASAL</Text>
            <Text style={styles.metaValue}>{transaction.originActorName}</Text>
          </View>
          <View style={styles.alignRight}>
            <Text style={textStyles.label}>REVISI</Text>
            <Text style={styles.metaValue}>#{transaction.revision}</Text>
          </View>
        </View>
        <View style={styles.rule} />
        {transaction.items.map((item) => (
          <View key={item.id} style={styles.item}>
            <View style={styles.itemCopy}>
              <Text style={styles.itemName}>{item.name}</Text>
              <Text style={styles.muted}>
                {item.quantity} × {formatRupiah(item.unitPrice)}
              </Text>
              <Text style={styles.snapshot}>
                SNAPSHOT PAKET REV. {item.packageRevision}
              </Text>
            </View>
            <Text style={styles.itemTotal}>{formatRupiah(item.lineTotal)}</Text>
          </View>
        ))}
        <View style={styles.rule} />
        <View style={styles.total}>
          <Text style={styles.totalLabel}>Total</Text>
          <Text style={textStyles.price}>
            {formatRupiah(transaction.total)}
          </Text>
        </View>
      </Card>

      <Card
        style={[
          styles.payment,
          paymentConfirmed ? styles.paymentSuccess : styles.paymentAttention,
        ]}
      >
        <View style={styles.paymentHeader}>
          <View style={styles.paymentCopy}>
            <Text style={textStyles.label}>PEMBAYARAN</Text>
            <Text style={styles.paymentTitle}>
              {paymentConfirmed
                ? "Pembayaran berhasil"
                : transaction.paymentStatus === "failed"
                  ? "Pembayaran gagal"
                  : "Menunggu konfirmasi"}
            </Text>
          </View>
          <PaymentStatusBadge status={transaction.paymentStatus} />
        </View>
        <Text style={styles.muted}>
          {paymentConfirmed
            ? `Lunas melalui ${
                transaction.paymentMethod === "cash"
                  ? "Tunai"
                  : transaction.paymentMethod === "qris"
                    ? "QRIS"
                    : "metode lama yang tidak tercatat"
              } untuk revisi #${transaction.revision}.`
            : "Struk baru dapat dicetak setelah pembayaran berhasil untuk revisi transaksi saat ini."}
        </Text>
        {session?.dataMode === "sandbox" &&
        transaction.paymentMethod === "qris" ? (
          <Text style={styles.sandboxPaymentAmount}>
            QRIS nyata: {formatRupiah(transaction.paymentAmount)} • Total
            simulasi: {formatRupiah(transaction.total)}
          </Text>
        ) : null}
      </Card>

      <Card style={styles.audit}>
        <Text style={textStyles.label}>JEJAK PERUBAHAN</Text>
        <Text style={styles.muted}>
          Dibuat oleh {transaction.originActorName}
        </Text>
        <Text style={styles.muted}>
          Terakhir diperbarui oleh {transaction.updatedActorName}
        </Text>
        <Text style={styles.terminal} numberOfLines={1}>
          TERMINAL {transaction.terminalId}
        </Text>
      </Card>

      {!paymentConfirmed ? (
        <Card style={styles.printLocked}>
          <Text style={styles.printLockedTitle}>Pencetakan terkunci</Text>
          <Text style={styles.muted}>
            {terminalBlocked
              ? "Pencetakan tetap terkunci sampai data server dipulihkan."
              : "Tandai pembayaran berhasil agar tombol cetak tersedia."}
          </Text>
        </Card>
      ) : null}
      {session?.user.role === "superadmin" ? (
        <Text style={styles.onlineOnly}>
          Penghapusan transaksi hanya tersedia saat online dan dilakukan dari
          aksi server setelah alasan dikonfirmasi.
        </Text>
      ) : null}
    </AppScreen>
  );
}

const baseStyles = StyleSheet.create({
  badges: { flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" },
  conflict: { gap: spacing.sm, backgroundColor: colors.warningSoft },
  conflictTitle: { ...textStyles.heading, color: colors.warning },
  syncBlocked: { gap: spacing.sm, backgroundColor: colors.errorSoft },
  syncBlockedTitle: { ...textStyles.heading, color: colors.error },
  muted: { ...textStyles.body, color: colors.textMuted },
  receipt: { gap: spacing.md },
  metaRow: { flexDirection: "row", justifyContent: "space-between" },
  metaValue: {
    fontFamily: typography.bodySemibold,
    color: colors.text,
    marginTop: spacing.xs,
  },
  alignRight: { alignItems: "flex-end" },
  rule: { height: 1, backgroundColor: colors.outline },
  item: { flexDirection: "row", gap: spacing.sm },
  itemCopy: { flex: 1 },
  itemName: {
    fontFamily: typography.headingSemibold,
    fontSize: 16,
    color: colors.text,
  },
  itemTotal: {
    fontFamily: typography.heading,
    fontSize: 16,
    color: colors.primary,
  },
  snapshot: { ...textStyles.technical, marginTop: spacing.xs, fontSize: 9 },
  total: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  totalLabel: { ...textStyles.heading },
  audit: { gap: spacing.xs, backgroundColor: colors.surfaceBright },
  payment: { gap: spacing.sm },
  paymentSuccess: { backgroundColor: colors.successSoft },
  paymentAttention: { backgroundColor: colors.warningSoft },
  paymentHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
  },
  paymentCopy: { flex: 1 },
  paymentTitle: { ...textStyles.heading, marginTop: spacing.xs },
  paymentError: { ...textStyles.body, color: colors.error },
  printLocked: { gap: spacing.xs, backgroundColor: colors.container },
  printLockedTitle: { ...textStyles.heading, color: colors.textMuted },
  terminal: { ...textStyles.technical, fontSize: 9 },
  onlineOnly: {
    ...textStyles.body,
    color: colors.textMuted,
    textAlign: "center",
    fontSize: 12,
  },
  sandboxPaymentAmount: {
    ...textStyles.body,
    color: colors.warning,
    fontFamily: typography.bodySemibold,
  },
});
