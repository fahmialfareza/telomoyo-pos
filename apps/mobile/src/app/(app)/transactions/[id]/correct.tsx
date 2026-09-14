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
import { PaymentMethodSelector } from "@/components/transactions/PaymentMethodSelector";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { QuantityStepper } from "@/components/ui/QuantityStepper";
import { StateView } from "@/components/ui/StateView";
import { correctTransaction, getTransaction } from "@/db/repositories";
import {
  canCorrectTransaction,
  CORRECTION_FORBIDDEN_MESSAGE,
} from "@/domain/permissions";
import {
  createDynamicQris,
  fingerprintStaticQris,
  validateStaticQris,
} from "@/domain/qris";
import { resolvePaymentAmount } from "@/domain/payments";
import type {
  QrisPayloadHash,
  SelectablePaymentMethod,
  Transaction,
} from "@/domain/types";
import { readQrisConfig, type QrisConfig } from "@/security/secure-store";
import { useSyncRuntime } from "@/sync/SyncProvider";
import { colors, spacing, textStyles, typography } from "@/theme/tokens";
import { displayTransactionId, formatRupiah } from "@/utils/format";

interface TransactionLoadResult {
  id: string;
  transaction: Transaction | null;
  error: string | null;
}

export default function CorrectTransactionScreen() {
  const responsive = useResponsiveStyles(styles);
  const responsiveText = useResponsiveTextStyles();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const sync = useSyncRuntime();
  const [loadResult, setLoadResult] = useState<TransactionLoadResult | null>(
    null,
  );
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [paymentMethod, setPaymentMethod] =
    useState<SelectablePaymentMethod | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [qrisConfig, setQrisConfig] = useState<QrisConfig | null>(null);
  const [qrisAvailable, setQrisAvailable] = useState(false);
  const [qrisConfigChecked, setQrisConfigChecked] = useState(false);

  useEffect(() => {
    let active = true;

    if (!id || !session) return;

    const qrisConfigPromise = readQrisConfig(
      session.tenantId ?? undefined,
    ).catch(() => null);
    void Promise.all([getTransaction(id, session), qrisConfigPromise])
      .then(([value, config]) => {
        if (!active) return;

        let available = false;
        if (config) {
          try {
            validateStaticQris(config.staticPayload);
            available = true;
          } catch {
            available = false;
          }
        }
        setQrisConfig(config);
        setQrisAvailable(available);
        setQrisConfigChecked(true);
        setLoadResult({ id, transaction: value, error: null });
        if (value) {
          setQuantities(
            Object.fromEntries(
              value.items.map((item) => [item.packageId, item.quantity]),
            ),
          );
          setPaymentMethod(
            value.paymentMethod === "legacy" ? null : value.paymentMethod,
          );
        }
      })
      .catch((reasonValue: unknown) => {
        if (!active) return;
        setQrisConfigChecked(true);
        setLoadResult({
          id,
          transaction: null,
          error:
            reasonValue instanceof Error
              ? reasonValue.message
              : "Transaksi tidak dapat dimuat.",
        });
      });

    return () => {
      active = false;
    };
  }, [id, session]);

  const currentLoad = loadResult?.id === id ? loadResult : null;

  if (id && !currentLoad) {
    return (
      <AppScreen>
        <PageHeader back title="Koreksi transaksi" />
      </AppScreen>
    );
  }

  const transaction = currentLoad?.transaction ?? null;

  if (!transaction) {
    return (
      <AppScreen>
        <PageHeader back title="Koreksi transaksi" />
        <StateView
          actionLabel="Kembali"
          icon="receipt-text-remove-outline"
          message={
            currentLoad?.error ?? "Transaksi tidak ditemukan di perangkat ini."
          }
          onAction={() => router.back()}
          title="Transaksi tidak ditemukan"
        />
      </AppScreen>
    );
  }

  const hasUnresolvedConflict = transaction.syncState === "conflict";
  const mayCorrect =
    !hasUnresolvedConflict &&
    transaction.deletedAt === null &&
    canCorrectTransaction(session, transaction);

  if (!mayCorrect) {
    return (
      <AppScreen>
        <PageHeader back title="Koreksi transaksi" />
        <StateView
          actionLabel="Kembali"
          icon="shield-lock-outline"
          message={
            hasUnresolvedConflict
              ? "Selesaikan konflik revisi sebelum mengoreksi transaksi ini."
              : transaction.deletedAt
                ? "Transaksi yang diarsipkan tidak dapat dikoreksi."
                : CORRECTION_FORBIDDEN_MESSAGE
          }
          onAction={() => router.back()}
          title="Koreksi tidak diizinkan"
        />
      </AppScreen>
    );
  }

  const total = transaction.items.reduce(
    (sum, item) =>
      sum + item.unitPrice * (quantities[item.packageId] ?? item.quantity),
    0,
  );

  const save = async () => {
    if (!session || !canCorrectTransaction(session, transaction)) {
      setError(CORRECTION_FORBIDDEN_MESSAGE);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (!paymentMethod) {
        throw new Error("Pilih metode pembayaran tunai atau QRIS.");
      }
      let qrisPayloadHash: QrisPayloadHash | null = null;
      if (paymentMethod === "qris") {
        if (!qrisConfig) {
          throw new Error(
            "QRIS belum dikonfigurasi. Minta superadmin mengatur QRIS merchant.",
          );
        }
        const staticQris = validateStaticQris(qrisConfig.staticPayload);
        createDynamicQris(
          staticQris.payload,
          resolvePaymentAmount(
            session.dataMode,
            paymentMethod,
            total,
            session.sandboxQrisPolicy,
          ),
        );
        qrisPayloadHash = await fingerprintStaticQris(staticQris.payload);
      }
      await correctTransaction(
        transaction.id,
        quantities,
        paymentMethod,
        qrisPayloadHash,
        reason,
        session,
      );
      await sync.refresh();
      void sync.syncNow();
      router.replace({
        pathname: "/transactions/[id]",
        params: { id: transaction.id },
      });
    } catch (reasonValue) {
      setError(
        reasonValue instanceof Error
          ? reasonValue.message
          : "Koreksi tidak dapat disimpan.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppScreen
      stickyFooter={
        <Button
          icon="content-save-edit-outline"
          disabled={
            !paymentMethod ||
            (paymentMethod === "qris" && (!qrisConfigChecked || !qrisAvailable))
          }
          loading={saving}
          onPress={() => void save()}
        >
          Simpan koreksi
        </Button>
      }
    >
      <PageHeader
        back
        subtitle={`${displayTransactionId(
          transaction.id,
          session?.dataMode ?? "production",
        )} • Revisi saat ini #${transaction.revision}`}
        title="Koreksi Transaksi"
      />
      <Card style={responsive.notice}>
        <Text style={responsive.noticeTitle}>
          Revisi tidak menghapus riwayat
        </Text>
        <Text style={responsive.muted}>
          Nilai sebelum dan sesudah disimpan permanen. Struk yang sudah dicetak
          akan ditandai perlu cetak ulang dan pembayaran harus dikonfirmasi
          kembali untuk total hasil koreksi.
        </Text>
      </Card>
      {transaction.items.map((item) => (
        <Card key={item.packageId} style={responsive.line}>
          <View style={responsive.copy}>
            <Text style={responsive.name}>{item.name}</Text>
            <Text style={responsive.muted}>{formatRupiah(item.unitPrice)}</Text>
          </View>
          <QuantityStepper
            onChange={(quantity) =>
              setQuantities((current) => ({
                ...current,
                [item.packageId]: quantity,
              }))
            }
            value={quantities[item.packageId] ?? item.quantity}
          />
        </Card>
      ))}
      <PaymentMethodSelector
        onChange={setPaymentMethod}
        qrisDisabled={!qrisConfigChecked || !qrisAvailable}
        qrisDisabledReason={
          qrisConfigChecked
            ? "QRIS belum dikonfigurasi oleh superadmin."
            : "Memeriksa konfigurasi QRIS…"
        }
        value={paymentMethod}
      />
      {transaction.paymentMethod === "legacy" && !paymentMethod ? (
        <Text style={responsive.legacyMethod}>
          Metode transaksi lama tidak tercatat. Pilih Tunai atau QRIS sebelum
          menyimpan koreksi.
        </Text>
      ) : null}
      <Field
        error={
          reason.length > 0 && reason.trim().length < 5
            ? "Alasan minimal 5 karakter."
            : undefined
        }
        label="Alasan koreksi"
        multiline
        numberOfLines={3}
        onChangeText={setReason}
        placeholder="Contoh: jumlah paket salah input"
        style={responsive.reason}
        value={reason}
      />
      <Card style={responsive.total}>
        <Text style={responsiveText.heading}>Total setelah koreksi</Text>
        <Text style={responsiveText.price}>{formatRupiah(total)}</Text>
      </Card>
      {error ? <Text style={responsive.error}>{error}</Text> : null}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  notice: { gap: spacing.xs, backgroundColor: colors.primarySoft },
  noticeTitle: { ...textStyles.heading, color: colors.primary },
  muted: { ...textStyles.body, color: colors.textMuted },
  line: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  copy: { flex: 1 },
  name: {
    fontFamily: typography.headingSemibold,
    fontSize: 16,
    color: colors.text,
  },
  reason: { minHeight: 96, textAlignVertical: "top", paddingTop: spacing.md },
  total: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  error: { ...textStyles.body, color: colors.error },
  legacyMethod: { ...textStyles.body, color: colors.warning },
});
