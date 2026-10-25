import { useResponsiveStyles, themed } from "@/theme/responsive";
import { useThemeColors } from "@/theme/ThemeContext";
import { FlashList, type ListRenderItemInfo } from "@shopify/flash-list";
import { useFocusEffect, useRouter } from "expo-router";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { useAuth } from "@/auth/AuthProvider";
import { AppScreen } from "@/components/layout/AppScreen";
import { PageHeader } from "@/components/layout/PageHeader";
import { CashPaymentSheet } from "@/components/payments/CashPaymentSheet";
import { ActionGroup } from "@/components/ui/ActionGroup";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { QuantityStepper } from "@/components/ui/QuantityStepper";
import { StateView } from "@/components/ui/StateView";
import { createTransaction, listPackages } from "@/db/repositories";
import {
  createDynamicQris,
  fingerprintStaticQris,
  validateStaticQris,
} from "@/domain/qris";
import { resolvePaymentAmount } from "@/domain/payments";
import type {
  QrisPayloadHash,
  RentalPackage,
  SelectablePaymentMethod,
} from "@/domain/types";
import { readQrisConfig } from "@/security/secure-store";
import { useSyncRuntime } from "@/sync/SyncProvider";
import {
  minimumTouchTarget,
  radius,
  spacing,
  typography,
} from "@/theme/tokens";
import { formatRupiah } from "@/utils/format";

export default function SaleComposerScreen() {
  const colors = useThemeColors();
  const responsive = useResponsiveStyles(styles);
  const router = useRouter();
  const { session } = useAuth();
  const sync = useSyncRuntime();
  const [packages, setPackages] = useState<RentalPackage[]>([]);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [loadingPackages, setLoadingPackages] = useState(true);
  const [packageError, setPackageError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const completedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [cashSheetOpen, setCashSheetOpen] = useState(false);
  const [qrisAvailable, setQrisAvailable] = useState(false);
  const [qrisConfigChecked, setQrisConfigChecked] = useState(false);

  const loadPackages = useCallback(async () => {
    if (!session) return;
    setLoadingPackages(true);
    setPackageError(null);
    try {
      setPackages(await listPackages(false, session));
    } catch (reason) {
      setPackageError(
        reason instanceof Error
          ? reason.message
          : "Daftar paket tidak dapat dimuat.",
      );
    } finally {
      setLoadingPackages(false);
    }
  }, [session]);

  const loadQrisAvailability = useCallback(async () => {
    if (!session?.tenantId) return;
    try {
      const config = await readQrisConfig(session.tenantId);
      const available =
        config !== null && Boolean(validateStaticQris(config.staticPayload));
      setQrisAvailable(available);
    } catch {
      setQrisAvailable(false);
    } finally {
      setQrisConfigChecked(true);
    }
  }, [session]);

  useFocusEffect(
    useCallback(() => {
      completedRef.current = false;
      void Promise.all([loadPackages(), loadQrisAvailability()]);
    }, [loadPackages, loadQrisAvailability]),
  );

  const total = useMemo(
    () =>
      packages.reduce(
        (sum, item) => sum + item.unitPrice * (quantities[item.id] ?? 0),
        0,
      ),
    [packages, quantities],
  );

  const selectedPackages = useMemo(
    () => packages.filter((item) => (quantities[item.id] ?? 0) > 0),
    [packages, quantities],
  );

  const selectedItemCount = useMemo(
    () =>
      selectedPackages.reduce(
        (sum, item) => sum + (quantities[item.id] ?? 0),
        0,
      ),
    [quantities, selectedPackages],
  );

  const updateQuantity = useCallback((packageId: string, quantity: number) => {
    setQuantities((current) => ({ ...current, [packageId]: quantity }));
  }, []);

  const renderPackage = useCallback(
    ({ item }: ListRenderItemInfo<RentalPackage>) => (
      <PackageSelectorCard
        item={item}
        onChange={updateQuantity}
        quantity={quantities[item.id] ?? 0}
      />
    ),
    [quantities, updateQuantity],
  );

  const save = async (
    paymentMethod: SelectablePaymentMethod,
    cashReceived?: number,
  ) => {
    if (!session || total === 0 || savingRef.current || completedRef.current)
      return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      let qrisPayloadHash: QrisPayloadHash | null = null;
      if (paymentMethod === "qris") {
        const qrisConfig = await readQrisConfig(session.tenantId ?? undefined);
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
      const transaction = await createTransaction(
        packages.map((item) => ({
          package: item,
          quantity: quantities[item.id] ?? 0,
        })),
        paymentMethod,
        qrisPayloadHash,
        session,
      );
      completedRef.current = true;
      setQuantities({});
      setCashSheetOpen(false);
      router.push({
        pathname:
          paymentMethod === "qris"
            ? "/transactions/[id]/print-qris"
            : "/transactions/[id]/print",
        params:
          paymentMethod === "qris"
            ? { id: transaction.id }
            : {
                id: transaction.id,
                autoPrint: "1",
                ...(cashReceived !== undefined
                  ? { cashReceived: String(cashReceived) }
                  : {}),
              },
      });
      void sync
        .refresh()
        .then(() => sync.syncNow())
        .catch(() => undefined);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Transaksi tidak dapat disimpan.",
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <AppScreen
      compactStickyFooter
      contentStyle={responsive.screen}
      scroll={false}
      stickyFooter={
        <StickyTransactionSummary
          disabled={total === 0 || loadingPackages}
          error={error}
          itemCount={selectedItemCount}
          loading={saving}
          onPaymentMethodChange={(method) => {
            if (method === "cash") {
              setError(null);
              setCashSheetOpen(true);
            } else {
              void save(method);
            }
          }}
          packageCount={selectedPackages.length}
          qrisAvailable={qrisAvailable}
          qrisConfigChecked={qrisConfigChecked}
          quantities={quantities}
          selectedPackages={selectedPackages}
          total={total}
        />
      }
    >
      <CashPaymentSheet
        error={cashSheetOpen ? error : null}
        onCancel={() => setCashSheetOpen(false)}
        onConfirm={(cashReceived) => void save("cash", cashReceived)}
        saving={saving}
        total={total}
        visible={cashSheetOpen}
      />
      <FlashList
        contentContainerStyle={responsive.listContent}
        data={packages}
        extraData={quantities}
        ItemSeparatorComponent={PackageSeparator}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        maintainVisibleContentPosition={{ disabled: true }}
        ListEmptyComponent={
          loadingPackages ? (
            <View style={responsive.loading}>
              <ActivityIndicator color={colors.primary} />
              <Text style={responsive.loadingText}>Memuat paket aktif…</Text>
            </View>
          ) : (
            <StateView
              {...(packageError
                ? {
                    actionLabel: "Coba lagi",
                    onAction: () => void loadPackages(),
                  }
                : {})}
              icon={packageError ? "alert-circle-outline" : "package-variant"}
              message={
                packageError ??
                "Belum ada paket aktif. Superadmin dapat menambahkannya dari Pengaturan."
              }
              title={packageError ? "Paket gagal dimuat" : "Belum ada paket"}
            />
          )
        }
        ListHeaderComponent={
          <View style={responsive.listHeader}>
            <PageHeader
              subtitle={`Kasir • ${session?.user.fullName ?? "-"}`}
              title="Transaksi baru"
            />
            <View style={responsive.sectionHeader}>
              <Text style={responsive.sectionTitle}>Pilih paket</Text>
              {selectedItemCount > 0 ? (
                <Button
                  compact
                  disabled={saving}
                  icon="close-circle-outline"
                  onPress={() => setQuantities({})}
                  variant="ghost"
                >
                  Kosongkan
                </Button>
              ) : null}
            </View>
            {packageError && packages.length > 0 ? (
              <Text accessibilityRole="alert" style={responsive.error}>
                {packageError}
              </Text>
            ) : null}
          </View>
        }
        onRefresh={() => void loadPackages()}
        refreshing={loadingPackages && packages.length > 0}
        renderItem={renderPackage}
        showsVerticalScrollIndicator={false}
        style={responsive.list}
      />
    </AppScreen>
  );
}

const PackageSelectorCard = memo(function PackageSelectorCard({
  item,
  quantity,
  onChange,
}: {
  item: RentalPackage;
  quantity: number;
  onChange: (packageId: string, quantity: number) => void;
}) {
  const colors = useThemeColors();
  const responsive = useResponsiveStyles(styles);
  const accent =
    item.accent === "sunrise"
      ? colors.sunrise
      : item.accent === "standard"
        ? colors.standard
        : colors.primary;

  return (
    // Tapping anywhere on the row adds one unit. Not exposed as its own
    // accessibility element so TalkBack still reaches the stepper buttons.
    <Pressable
      accessible={false}
      onPress={() => onChange(item.id, Math.min(999, quantity + 1))}
    >
      {({ pressed }) => (
        <Card
          style={[
            responsive.packageCard,
            {
              borderColor: quantity > 0 ? accent : colors.outline,
              borderLeftColor: accent,
            },
            ...(quantity > 0 ? [responsive.packageCardSelected] : []),
            ...(pressed ? [responsive.packageCardPressed] : []),
          ]}
        >
          <View style={responsive.packageCopy}>
            <Text numberOfLines={2} style={responsive.packageName}>
              {item.name}
            </Text>
            {item.description ? (
              <Text numberOfLines={1} style={responsive.description}>
                {item.description}
              </Text>
            ) : null}
            <Text style={[responsive.packagePrice, { color: accent }]}>
              {formatRupiah(item.unitPrice)}
            </Text>
          </View>
          <QuantityStepper
            onChange={(nextQuantity) => onChange(item.id, nextQuantity)}
            value={quantity}
          />
        </Card>
      )}
    </Pressable>
  );
});

function PackageSeparator() {
  const responsive = useResponsiveStyles(styles);
  return <View style={responsive.packageSeparator} />;
}

function StickyTransactionSummary({
  packageCount,
  itemCount,
  total,
  disabled,
  loading,
  error,
  qrisAvailable,
  qrisConfigChecked,
  onPaymentMethodChange,
  selectedPackages,
  quantities,
}: {
  packageCount: number;
  itemCount: number;
  total: number;
  disabled: boolean;
  loading: boolean;
  error: string | null;
  qrisAvailable: boolean;
  qrisConfigChecked: boolean;
  onPaymentMethodChange: (method: SelectablePaymentMethod) => void;
  selectedPackages: RentalPackage[];
  quantities: Record<string, number>;
}) {
  const colors = useThemeColors();
  const responsive = useResponsiveStyles(styles);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const summaryToggle = (
    <Pressable
      accessibilityLabel={
        summaryExpanded ? "Sembunyikan ringkasan" : "Tampilkan ringkasan"
      }
      accessibilityRole="button"
      accessibilityState={{ expanded: summaryExpanded }}
      onPress={() => setSummaryExpanded((expanded) => !expanded)}
      style={responsive.summaryToggle}
    >
      <Icon
        color={colors.primary}
        name={summaryExpanded ? "chevron-down" : "chevron-up"}
        size={20}
      />
    </Pressable>
  );
  return (
    <Card padded={false} style={responsive.stickySummary}>
      {summaryExpanded ? (
        <View style={responsive.stickySummaryHeader}>
          <Text style={responsive.stickyTotalLabel}>Ringkasan</Text>
          <Text style={responsive.stickySummaryMeta}>
            {packageCount === 0
              ? "Belum ada paket dipilih"
              : `${packageCount} paket • ${itemCount} item`}
          </Text>
        </View>
      ) : null}
      {summaryExpanded && selectedPackages.length > 0 ? (
        <ScrollView
          contentContainerStyle={responsive.summaryLinesContent}
          nestedScrollEnabled
          showsVerticalScrollIndicator={selectedPackages.length > 2}
          style={responsive.summaryLines}
        >
          {selectedPackages.map((item) => {
            const quantity = quantities[item.id] ?? 0;

            return (
              <View key={item.id} style={responsive.summaryLine}>
                <View style={responsive.summaryLineCopy}>
                  <Text numberOfLines={1} style={responsive.summaryLineName}>
                    {item.name}
                  </Text>
                  <Text style={responsive.summaryLineCalculation}>
                    {quantity} × {formatRupiah(item.unitPrice)}
                  </Text>
                </View>
                <Text style={responsive.summaryLineTotal}>
                  {formatRupiah(quantity * item.unitPrice)}
                </Text>
              </View>
            );
          })}
        </ScrollView>
      ) : null}
      <View style={responsive.stickyTotalRow}>
        <View style={responsive.stickyTotalLabelGroup}>
          <Text style={responsive.stickyTotalLabel}>Total pembayaran</Text>
          {summaryToggle}
        </View>
        <Text accessibilityLiveRegion="polite" style={responsive.stickyTotal}>
          {formatRupiah(total)}
        </Text>
      </View>
      <ActionGroup horizontal>
        <Button
          accessibilityHint="Membuka pembayaran tunai untuk menghitung kembalian."
          disabled={disabled}
          icon="cash"
          loading={loading}
          onPress={() => onPaymentMethodChange("cash")}
        >
          Bayar Tunai
        </Button>
        <Button
          accessibilityHint="Menyimpan transaksi dan menampilkan QRIS untuk dibayar."
          disabled={disabled || !qrisConfigChecked || !qrisAvailable}
          icon="qrcode-scan"
          loading={loading}
          onPress={() => onPaymentMethodChange("qris")}
        >
          Bayar QRIS
        </Button>
      </ActionGroup>
      {!qrisConfigChecked || !qrisAvailable ? (
        <Text style={responsive.stickySummaryMeta}>
          {qrisConfigChecked
            ? "QRIS belum dikonfigurasi oleh superadmin."
            : "Memeriksa konfigurasi QRIS…"}
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={responsive.stickyError}>
          {error}
        </Text>
      ) : null}
    </Card>
  );
}

const styles = themed(({ colors, textStyles }) =>
  StyleSheet.create({
    screen: {
      padding: 0,
      paddingBottom: 0,
      gap: 0,
    },
    list: { flex: 1 },
    listContent: {
      paddingHorizontal: spacing.md,
      paddingTop: spacing.md,
      paddingBottom: spacing.xl,
    },
    listHeader: {
      gap: spacing.md,
      marginBottom: spacing.md,
    },
    sectionHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    sectionTitle: { ...textStyles.heading },
    packageCard: {
      borderLeftWidth: 5,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      paddingVertical: spacing.sm,
    },
    packageCardSelected: { backgroundColor: colors.surfaceBright },
    packageCardPressed: { opacity: 0.85 },
    packageCopy: { flex: 1, gap: 2 },
    packageName: {
      fontFamily: typography.heading,
      fontSize: 18,
      color: colors.text,
    },
    description: { ...textStyles.body, color: colors.textMuted, fontSize: 13 },
    packagePrice: {
      fontFamily: typography.heading,
      fontSize: 16,
    },
    packageSeparator: { height: spacing.sm },
    stickySummary: {
      gap: spacing.xs,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      borderRadius: radius.md,
      backgroundColor: colors.card,
    },
    stickySummaryHeader: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      justifyContent: "space-between",
      gap: spacing.sm,
    },
    stickySummaryMeta: {
      ...textStyles.label,
      color: colors.textMuted,
      fontSize: 11,
    },
    summaryToggle: {
      minHeight: minimumTouchTarget,
      minWidth: minimumTouchTarget,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
    },
    summaryLines: {
      maxHeight: 112,
      paddingRight: spacing.xs,
    },
    summaryLinesContent: {
      gap: spacing.sm,
    },
    summaryLine: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
    },
    summaryLineCopy: {
      flex: 1,
    },
    summaryLineName: {
      ...textStyles.body,
      color: colors.text,
      fontFamily: typography.bodySemibold,
    },
    summaryLineCalculation: {
      ...textStyles.label,
      color: colors.textMuted,
      fontSize: 10,
    },
    summaryLineTotal: {
      ...textStyles.body,
      color: colors.text,
      fontFamily: typography.bodySemibold,
      textAlign: "right",
    },
    stickyTotalRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      justifyContent: "space-between",
      gap: spacing.sm,
    },
    stickyTotalLabelGroup: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.xs,
    },
    stickyTotalLabel: {
      ...textStyles.body,
      color: colors.text,
      fontFamily: typography.bodySemibold,
    },
    stickyTotal: {
      fontFamily: typography.price,
      fontSize: 22,
      lineHeight: 28,
      letterSpacing: -0.4,
      color: colors.primary,
      textAlign: "right",
    },
    error: {
      ...textStyles.body,
      color: colors.error,
      backgroundColor: colors.errorSoft,
      padding: spacing.md,
      borderRadius: radius.md,
    },
    stickyError: {
      ...textStyles.body,
      color: colors.error,
      fontSize: 12,
    },
    loading: {
      paddingVertical: spacing.xl,
      alignItems: "center",
      gap: spacing.sm,
    },
    loadingText: { ...textStyles.body, color: colors.textMuted },
  }),
);
