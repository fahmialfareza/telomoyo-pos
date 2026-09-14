import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Keyboard, Pressable, StyleSheet, Text, View } from "react-native";

import { useAuth } from "@/auth/AuthProvider";
import { HistoryTransactionCard } from "@/components/history/HistoryTransactionCard";
import { AppScreen } from "@/components/layout/AppScreen";
import { PageHeader } from "@/components/layout/PageHeader";
import { DateMonthFilter } from "@/components/reporting/DateMonthFilter";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { StateView } from "@/components/ui/StateView";
import { useResponsiveStyles } from "@/theme/responsive";
import {
  listHistoryCreatorOptions,
  listHistoryPackageOptions,
  listTransactions,
  type HistoryFilter,
  type HistoryFilterOption,
} from "@/db/repositories";
import type { SyncState, Transaction } from "@/domain/types";
import {
  colors,
  minimumTouchTarget,
  radius,
  spacing,
  textStyles,
  typography,
} from "@/theme/tokens";
import {
  currentJakartaDate,
  currentJakartaMonth,
  reportingRange,
  type ReportingMode,
} from "@/utils/time";

const pageSize = 20;

const syncFilters: { label: string; value?: SyncState }[] = [
  { label: "Semua" },
  { label: "Menunggu", value: "pending" },
  { label: "Tersinkron", value: "synced" },
  { label: "Konflik", value: "conflict" },
  { label: "Error", value: "error" },
];

export default function HistoryScreen() {
  const styles = useResponsiveStyles(baseStyles);
  const router = useRouter();
  const { session } = useAuth();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [mode, setMode] = useState<ReportingMode>("date");
  const [selectedDate, setSelectedDate] = useState(currentJakartaDate);
  const [selectedMonth, setSelectedMonth] = useState(currentJakartaMonth);
  const [packageId, setPackageId] = useState<string | undefined>();
  const [creatorId, setCreatorId] = useState<string | undefined>();
  const [syncState, setSyncState] = useState<SyncState | undefined>();
  const [packageOptions, setPackageOptions] = useState<HistoryFilterOption[]>(
    [],
  );
  const [creatorOptions, setCreatorOptions] = useState<HistoryFilterOption[]>(
    [],
  );
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const cursor = useRef<{ occurredAt: string; id: string } | null>(null);
  const requestId = useRef(0);
  const today = currentJakartaDate();
  const activeFilterCount =
    Number(mode !== "date" || selectedDate !== today) +
    Number(packageId !== undefined) +
    Number(creatorId !== undefined) +
    Number(syncState !== undefined);

  const loadOptions = useCallback(async () => {
    if (!session) return;
    const [packages, creators] = await Promise.all([
      listHistoryPackageOptions(session),
      listHistoryCreatorOptions(session),
    ]);
    setPackageOptions(packages);
    setCreatorOptions(creators);
  }, [session]);

  const load = useCallback(
    async (append: boolean) => {
      if (!session) return;
      const currentRequestId = ++requestId.current;
      setLoading(true);
      if (!append) {
        cursor.current = null;
        setHasMore(false);
        setTransactions([]);
      }
      try {
        const range =
          mode === "date"
            ? reportingRange("date", selectedDate)
            : reportingRange("month", selectedMonth);
        const currentCursor = append ? cursor.current : null;
        const filter: HistoryFilter = {
          limit: pageSize + 1,
          ...(search ? { search } : {}),
          ...(syncState ? { syncState } : {}),
          from: range.from,
          to: range.to,
          ...(packageId ? { packageId } : {}),
          ...(creatorId ? { creatorId } : {}),
          ...(currentCursor
            ? {
                beforeOccurredAt: currentCursor.occurredAt,
                beforeId: currentCursor.id,
              }
            : {}),
        };
        const rows = await listTransactions(filter, session);
        if (currentRequestId !== requestId.current) return;
        const page = rows.slice(0, pageSize);
        const last = page.at(-1);
        cursor.current = last
          ? { occurredAt: last.occurredAt, id: last.id }
          : null;
        setHasMore(rows.length > pageSize);
        setTransactions((current) => (append ? [...current, ...page] : page));
      } finally {
        if (currentRequestId === requestId.current) {
          setLoading(false);
        }
      }
    },
    [
      creatorId,
      mode,
      packageId,
      search,
      selectedDate,
      selectedMonth,
      syncState,
      session,
    ],
  );

  useFocusEffect(
    useCallback(() => {
      void load(false);
    }, [load]),
  );

  useFocusEffect(
    useCallback(() => {
      void loadOptions();
    }, [loadOptions]),
  );

  const submitSearch = () => {
    Keyboard.dismiss();
    const next = searchInput.trim();
    if (next === search) {
      void load(false);
    } else {
      setSearch(next);
    }
  };

  const resetFilters = () => {
    const now = new Date();
    setMode("date");
    setSelectedDate(currentJakartaDate(now));
    setSelectedMonth(currentJakartaMonth(now));
    setPackageId(undefined);
    setCreatorId(undefined);
    setSyncState(undefined);
  };

  return (
    <AppScreen>
      <PageHeader
        subtitle="Cari transaksi, cek status, dan buka detailnya."
        title="Riwayat"
      />
      <View style={styles.searchControls}>
        <Button
          accessibilityLabel={
            searchExpanded ? "Sembunyikan pencarian" : "Tampilkan pencarian"
          }
          accessibilityState={{ expanded: searchExpanded }}
          icon={searchExpanded ? "chevron-up" : "magnify"}
          onPress={() => {
            Keyboard.dismiss();
            setSearchExpanded((expanded) => !expanded);
          }}
          variant="secondary"
        >
          {searchExpanded ? "Sembunyikan pencarian" : "Cari transaksi"}
        </Button>
        {searchExpanded ? (
          <Field
            autoCapitalize="characters"
            label="Cari transaksi"
            onChangeText={setSearchInput}
            onSubmitEditing={submitSearch}
            placeholder="ID transaksi atau nama kasir"
            returnKeyType="search"
            value={searchInput}
          />
        ) : null}
        {search ? (
          <Pressable
            accessibilityLabel={`Hapus pencarian ${search}`}
            accessibilityRole="button"
            onPress={() => {
              Keyboard.dismiss();
              setSearchInput("");
              setSearch("");
            }}
            style={({ pressed }) => [
              styles.searchChip,
              pressed && styles.pressed,
            ]}
          >
            <Icon color={colors.primary} name="magnify" size={18} />
            <Text style={styles.searchChipText}>Pencarian: {search}</Text>
            <Icon color={colors.primary} name="close" size={20} />
          </Pressable>
        ) : null}
      </View>

      <DateMonthFilter
        date={selectedDate}
        mode={mode}
        month={selectedMonth}
        onDateChange={setSelectedDate}
        onModeChange={setMode}
        onMonthChange={setSelectedMonth}
      />

      <View style={styles.resultToolbar}>
        <View style={styles.resultSummary}>
          <Text style={styles.resultTitle}>TRANSAKSI</Text>
          <Text style={styles.resultCount}>
            {loading && transactions.length === 0
              ? "Memuat riwayat…"
              : `${transactions.length} hasil · terbaru dulu`}
          </Text>
        </View>
        <Pressable
          accessibilityLabel={
            filtersExpanded
              ? "Sembunyikan filter lainnya"
              : "Tampilkan filter lainnya"
          }
          accessibilityRole="button"
          accessibilityState={{ expanded: filtersExpanded }}
          onPress={() => setFiltersExpanded((expanded) => !expanded)}
          style={({ pressed }) => [
            styles.filterButton,
            filtersExpanded && styles.filterButtonExpanded,
            pressed && styles.pressed,
          ]}
        >
          <Icon
            color={filtersExpanded ? colors.primary : colors.textMuted}
            name="tune-variant"
            size={20}
          />
          <Text
            style={[
              styles.filterButtonText,
              filtersExpanded && styles.filterButtonTextExpanded,
            ]}
          >
            Filter
          </Text>
          {activeFilterCount > 0 ? (
            <View style={styles.filterCount}>
              <Text style={styles.filterCountText}>{activeFilterCount}</Text>
            </View>
          ) : null}
          <Icon
            color={filtersExpanded ? colors.primary : colors.textMuted}
            name={filtersExpanded ? "chevron-up" : "chevron-down"}
            size={20}
          />
        </Pressable>
      </View>

      {filtersExpanded ? (
        <View style={styles.filterPanel}>
          <View style={styles.filterPanelHeader}>
            <View style={styles.filterPanelTitle}>
              <Icon color={colors.primary} name="filter-outline" size={20} />
              <Text style={styles.filterPanelTitleText}>Filter lainnya</Text>
            </View>
            {activeFilterCount > 0 ? (
              <Pressable
                accessibilityLabel="Reset semua filter"
                accessibilityRole="button"
                onPress={resetFilters}
                style={({ pressed }) => [
                  styles.resetButton,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.resetButtonText}>Reset</Text>
              </Pressable>
            ) : null}
          </View>

          {packageOptions.length > 0 ? (
            <FilterGroup title="PAKET">
              <FilterChip
                label="Semua"
                onPress={() => setPackageId(undefined)}
                selected={packageId === undefined}
              />
              {packageOptions.map((option) => (
                <FilterChip
                  key={option.id}
                  label={option.label}
                  onPress={() => setPackageId(option.id)}
                  selected={packageId === option.id}
                />
              ))}
            </FilterGroup>
          ) : null}

          {creatorOptions.length > 0 ? (
            <FilterGroup title="PEMBUAT">
              <FilterChip
                label="Semua"
                onPress={() => setCreatorId(undefined)}
                selected={creatorId === undefined}
              />
              {creatorOptions.map((option) => (
                <FilterChip
                  key={option.id}
                  label={option.label}
                  onPress={() => setCreatorId(option.id)}
                  selected={creatorId === option.id}
                />
              ))}
            </FilterGroup>
          ) : null}

          <FilterGroup title="STATUS SINKRON">
            {syncFilters.map((filter) => (
              <FilterChip
                key={filter.label}
                label={filter.label}
                onPress={() => setSyncState(filter.value)}
                selected={syncState === filter.value}
              />
            ))}
          </FilterGroup>
        </View>
      ) : null}

      {transactions.length === 0 && !loading ? (
        <StateView
          icon="receipt-text-outline"
          message="Coba ubah pencarian atau filter, atau buat transaksi baru."
          title="Belum ada transaksi"
        />
      ) : (
        transactions.map((transaction) => (
          <HistoryTransactionCard
            dataMode={session?.dataMode ?? "production"}
            key={transaction.id}
            onPress={() =>
              router.push({
                pathname: "/transactions/[id]",
                params: { id: transaction.id },
              })
            }
            transaction={transaction}
          />
        ))
      )}
      {hasMore ? (
        <Button
          loading={loading}
          onPress={() => void load(true)}
          variant="secondary"
        >
          Muat transaksi berikutnya
        </Button>
      ) : null}
    </AppScreen>
  );
}

function FilterGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const styles = useResponsiveStyles(baseStyles);
  return (
    <View style={styles.group}>
      <Text style={styles.groupTitle}>{title}</Text>
      <View style={styles.filters}>{children}</View>
    </View>
  );
}

function FilterChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const styles = useResponsiveStyles(baseStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.filter,
        selected && styles.filterSelected,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.filterText, selected && styles.filterTextSelected]}>
        {label}
      </Text>
    </Pressable>
  );
}

const baseStyles = StyleSheet.create({
  searchControls: { gap: spacing.sm },
  searchChip: {
    minHeight: minimumTouchTarget,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
  },
  searchChipText: { ...textStyles.body, color: colors.primary, flex: 1 },
  resultToolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  resultSummary: {
    flex: 1,
    gap: 2,
  },
  resultTitle: {
    ...textStyles.label,
    color: colors.text,
  },
  resultCount: {
    ...textStyles.body,
    color: colors.textMuted,
    fontSize: 12,
  },
  filterButton: {
    minHeight: minimumTouchTarget,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.outline,
    backgroundColor: colors.card,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
  },
  filterButtonExpanded: {
    borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
  },
  filterButtonText: {
    ...textStyles.body,
    color: colors.textMuted,
    fontFamily: typography.bodyMedium,
  },
  filterButtonTextExpanded: {
    color: colors.primary,
  },
  filterCount: {
    minWidth: 20,
    height: 20,
    borderRadius: radius.pill,
    paddingHorizontal: 5,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  filterCountText: {
    fontFamily: typography.bodySemibold,
    fontSize: 11,
    color: colors.onPrimary,
  },
  filterPanel: {
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.outline,
    backgroundColor: colors.card,
    gap: spacing.md,
  },
  filterPanelHeader: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  filterPanelTitle: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  filterPanelTitleText: {
    fontFamily: typography.headingSemibold,
    fontSize: 16,
    color: colors.text,
  },
  resetButton: {
    minHeight: minimumTouchTarget,
    minWidth: minimumTouchTarget,
    paddingHorizontal: spacing.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  resetButtonText: {
    ...textStyles.body,
    color: colors.primary,
    fontFamily: typography.bodySemibold,
  },
  group: {
    gap: spacing.sm,
  },
  groupTitle: {
    ...textStyles.label,
    color: colors.textMuted,
  },
  filters: {
    flexDirection: "row",
    gap: spacing.sm,
    flexWrap: "wrap",
  },
  filter: {
    minHeight: minimumTouchTarget,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.outline,
    backgroundColor: colors.card,
  },
  filterSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  filterText: { ...textStyles.body, fontFamily: typography.bodyMedium },
  filterTextSelected: { color: colors.onPrimary },
  pressed: {
    opacity: 0.72,
  },
});
