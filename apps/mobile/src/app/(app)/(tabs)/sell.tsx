import { useResponsiveStyles } from "@/theme/responsive";
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
import { PaymentMethodSelector } from "@/components/transactions/PaymentMethodSelector";
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
  colors,
  minimumTouchTarget,
  radius,
  spacing,
  textStyles,
  typography,
} from "@/theme/tokens";
import { formatRupiah } from "@/utils/format";

export default function SaleComposerScreen() {
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

  const save = async (paymentMethod: SelectablePaymentMethod) => {
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
      router.push({
        pathname:
          paymentMethod === "qris"
            ? "/transactions/[id]/print-qris"
            : "/transactions/[id]/print",
        params:
          paymentMethod === "qris"
            ? { id: transaction.id }
            : { id: transaction.id, autoPrint: "1" },
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
          onPaymentMethodChange={(method) => void save(method)}
          packageCount={selectedPackages.length}
          qrisAvailable={qrisAvailable}
          qrisConfigChecked={qrisConfigChecked}
          quantities={quantities}
          selectedPackages={selectedPackages}
          total={total}
        />
      }
    >
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
              <View>
                <Text style={responsive.sectionEyebrow}>KATALOG AKTIF</Text>
                <Text style={responsive.sectionTitle}>Pilih paket</Text>
              </View>
              <View style={responsive.packageCount}>
                <Text style={responsive.packageCountText}>
                  {packages.length}
                </Text>
              </View>
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
  const responsive = useResponsiveStyles(styles);
  const accent =
    item.accent === "sunrise"
      ? colors.sunrise
      : item.accent === "standard"
        ? colors.standard
        : colors.primary;
  const label =
    item.accent === "sunrise"
      ? "SUNRISE"
      : item.accent === "standard"
        ? "STANDAR"
        : "PAKET";

  return (
    <Card
      style={[
        responsive.packageCard,
        {
          borderColor: quantity > 0 ? accent : colors.outline,
          borderLeftColor: accent,
        },
      ]}
    >
      <View style={responsive.packageTop}>
        <View style={responsive.packageCopy}>
          <Text style={[responsive.packageLabel, { color: accent }]}>
            {label}
          </Text>
          <Text style={responsive.packageName}>{item.name}</Text>
        </View>
        {quantity > 0 ? (
          <View style={[responsive.selectedBadge, { backgroundColor: accent }]}>
            <Icon color={colors.onPrimary} name="check" size={16} />
          </View>
        ) : null}
      </View>
      <Text numberOfLines={2} style={responsive.description}>
        {item.description}
      </Text>
      <View style={responsive.packageBottom}>
        <View>
          <Text style={responsive.priceLabel}>HARGA SATUAN</Text>
          <Text style={[responsive.packagePrice, { color: accent }]}>
            {formatRupiah(item.unitPrice)}
          </Text>
        </View>
        <QuantityStepper
          onChange={(nextQuantity) => onChange(item.id, nextQuantity)}
          value={quantity}
        />
      </View>
    </Card>
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
          <Text style={responsive.sectionEyebrow}>RINGKASAN</Text>
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
      <PaymentMethodSelector
        actionHint="Pilihan ini langsung menyimpan transaksi dan memulai pencetakan."
        disabled={disabled || loading}
        label="PILIH METODE UNTUK SIMPAN"
        onChange={onPaymentMethodChange}
        qrisDisabled={!qrisConfigChecked || !qrisAvailable}
        qrisDisabledReason={
          qrisConfigChecked
            ? "QRIS belum dikonfigurasi oleh superadmin."
            : "Memeriksa konfigurasi QRIS…"
        }
        value={null}
      />
      {loading ? (
        <View style={responsive.savingRow}>
          <ActivityIndicator color={colors.primary} />
          <Text style={responsive.stickySummaryMeta}>Menyimpan transaksi…</Text>
        </View>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={responsive.stickyError}>
          {error}
        </Text>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
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
  sectionEyebrow: {
    ...textStyles.label,
    color: colors.primary,
    fontSize: 10,
  },
  sectionTitle: { ...textStyles.heading, marginTop: 2 },
  packageCount: {
    minWidth: 36,
    height: 36,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.container,
  },
  packageCountText: {
    ...textStyles.body,
    fontFamily: typography.bodySemibold,
    color: colors.primary,
  },
  packageCard: {
    borderLeftWidth: 5,
    gap: spacing.sm,
  },
  packageTop: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
  },
  packageCopy: { flex: 1, gap: 2 },
  packageLabel: { ...textStyles.label, fontSize: 10 },
  packageName: {
    fontFamily: typography.heading,
    fontSize: 18,
    color: colors.text,
  },
  description: { ...textStyles.body, color: colors.textMuted, fontSize: 13 },
  selectedBadge: {
    width: 28,
    height: 28,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  packageBottom: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.outline,
  },
  priceLabel: { ...textStyles.label, fontSize: 9 },
  packagePrice: {
    fontFamily: typography.heading,
    fontSize: 18,
    marginTop: 2,
  },
  packageSeparator: { height: spacing.sm },
  stickySummary: {
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.md,
    backgroundColor: colors.card,
  },
  savingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
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
});
