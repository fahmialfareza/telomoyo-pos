import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { useAuth } from "@/auth/AuthProvider";
import { AppScreen } from "@/components/layout/AppScreen";
import { PageHeader } from "@/components/layout/PageHeader";
import {
  DateMonthFilter,
  formatReportingDate,
  formatReportingMonth,
} from "@/components/reporting/DateMonthFilter";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { StateView } from "@/components/ui/StateView";
import { getDashboardStats } from "@/db/repositories";
import { canExportReports } from "@/domain/permissions";
import type { DashboardStats } from "@/domain/types";
import { getConfiguredPrinter } from "@/printer/service";
import type { RecapPrintDocument } from "@/printer/types";
import { shareTransactionsCsv } from "@/reports/transactions-csv";
import { useSyncRuntime } from "@/sync/SyncProvider";
import { themed, useResponsiveStyles } from "@/theme/responsive";
import { useThemeColors } from "@/theme/ThemeContext";
import { radius, spacing, typography } from "@/theme/tokens";
import { toUserFacingErrorMessage } from "@/utils/errors";
import { formatRupiah } from "@/utils/format";
import {
  currentJakartaDate,
  currentJakartaMonth,
  reportingRange,
  type ReportingMode,
} from "@/utils/time";

export default function RecapScreen() {
  const colors = useThemeColors();
  const styles = useResponsiveStyles(baseStyles);
  const { session } = useAuth();
  const { pendingCount } = useSyncRuntime();
  const [mode, setMode] = useState<ReportingMode>("date");
  const [selectedDate, setSelectedDate] = useState(currentJakartaDate);
  const [selectedMonth, setSelectedMonth] = useState(currentJakartaMonth);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [printMessage, setPrintMessage] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const requestId = useRef(0);

  const periodLabel =
    mode === "date"
      ? formatReportingDate(selectedDate)
      : formatReportingMonth(selectedMonth);

  const load = useCallback(async () => {
    if (!session) return;
    const current = ++requestId.current;
    setStats(null);
    setLoadError(null);
    try {
      const next = await getDashboardStats(
        mode === "date"
          ? reportingRange("date", selectedDate)
          : reportingRange("month", selectedMonth),
        session,
      );
      if (current === requestId.current) setStats(next);
    } catch (reason) {
      if (current !== requestId.current) return;
      setLoadError(
        toUserFacingErrorMessage(reason, "Rekap tidak dapat dimuat."),
      );
    }
  }, [mode, selectedDate, selectedMonth, session]);

  useFocusEffect(
    useCallback(() => {
      void load();
      return () => {
        requestId.current += 1;
      };
    }, [load]),
  );

  const print = async () => {
    if (!stats || !session || printing) return;
    setPrinting(true);
    setPrintMessage(null);
    const document: RecapPrintDocument = {
      title: mode === "date" ? "REKAP HARIAN" : "REKAP BULANAN",
      periodLabel,
      printedAt: new Date().toISOString(),
      ...(session.tenant?.name ? { businessName: session.tenant.name } : {}),
      stats,
      pendingCount,
      dataMode: session.dataMode,
    };
    let printer:
      Awaited<ReturnType<typeof getConfiguredPrinter>>["printer"] | null = null;
    try {
      const configured = await getConfiguredPrinter();
      printer = configured.printer;
      await printer.connect(configured.config.address ?? undefined);
      const result = await printer.printRecap(document);
      setPrintMessage(
        result.status === "success"
          ? { tone: "success", text: "Rekap dicetak." }
          : { tone: "error", text: result.message },
      );
    } catch (reason) {
      setPrintMessage({
        tone: "error",
        text: toUserFacingErrorMessage(reason, "Rekap tidak dapat dicetak."),
      });
    } finally {
      await printer?.disconnect().catch(() => undefined);
      setPrinting(false);
    }
  };

  const exportCsv = async () => {
    if (!session || exporting) return;
    setExporting(true);
    setPrintMessage(null);
    try {
      const shared = await shareTransactionsCsv({
        range:
          mode === "date"
            ? reportingRange("date", selectedDate)
            : reportingRange("month", selectedMonth),
        fileLabel: mode === "date" ? selectedDate : selectedMonth,
        scope: session,
        dataMode: session.dataMode,
      });
      if (!shared) {
        setPrintMessage({
          tone: "error",
          text: "Tidak ada transaksi lunas untuk diekspor pada periode ini.",
        });
      }
    } catch (reason) {
      setPrintMessage({
        tone: "error",
        text: toUserFacingErrorMessage(reason, "Laporan tidak dapat diekspor."),
      });
    } finally {
      setExporting(false);
    }
  };

  return (
    <AppScreen>
      <PageHeader
        back
        subtitle="Serah terima kas dan ringkasan penjualan"
        title="Rekap"
      />
      <DateMonthFilter
        date={selectedDate}
        mode={mode}
        month={selectedMonth}
        onDateChange={setSelectedDate}
        onModeChange={setMode}
        onMonthChange={setSelectedMonth}
      />

      {pendingCount > 0 ? (
        <Card style={styles.warning}>
          <Text accessibilityRole="alert" style={styles.warningText}>
            {pendingCount} perubahan belum sinkron. Rekap ini hanya memuat data
            yang tersimpan di perangkat ini.
          </Text>
        </Card>
      ) : null}

      {loadError ? (
        <StateView
          actionLabel="Coba lagi"
          icon="alert-circle-outline"
          message={loadError}
          onAction={() => void load()}
          title="Rekap gagal dimuat"
        />
      ) : (
        <>
          <Card style={styles.summary}>
            <Text style={styles.label}>PENDAPATAN • {periodLabel}</Text>
            <Text style={styles.gross}>
              {stats ? formatRupiah(stats.gross) : "—"}
            </Text>
            <Text style={styles.meta}>
              {stats ? `${stats.transactionCount} transaksi lunas` : "Memuat…"}
            </Text>
          </Card>

          <View style={styles.methodRow}>
            <Card style={styles.method}>
              <Text style={styles.label}>TUNAI</Text>
              <Text style={styles.methodValue}>
                {stats ? formatRupiah(stats.cashAmount) : "—"}
              </Text>
            </Card>
            <Card style={styles.method}>
              <Text style={styles.label}>
                {session?.dataMode === "sandbox" ? "QRIS NYATA" : "QRIS"}
              </Text>
              <Text style={styles.methodValue}>
                {stats ? formatRupiah(stats.actualQrisAmount) : "—"}
              </Text>
            </Card>
          </View>

          <Card padded={false}>
            <Text style={[styles.label, styles.tableTitle]}>PER PAKET</Text>
            {stats && stats.quantities.length === 0 ? (
              <Text style={[styles.meta, styles.packageRow]}>
                Belum ada paket terjual pada periode ini.
              </Text>
            ) : null}
            {stats?.quantities.map((item) => (
              <View key={item.name} style={styles.packageRow}>
                <View
                  style={[
                    styles.accent,
                    {
                      backgroundColor:
                        item.accent === "sunrise"
                          ? colors.sunrise
                          : item.accent === "standard"
                            ? colors.standard
                            : colors.primary,
                    },
                  ]}
                />
                <View style={styles.packageCopy}>
                  <Text style={styles.packageName}>{item.name}</Text>
                  <Text style={styles.meta}>{item.quantity} unit</Text>
                </View>
                <Text style={styles.packageRevenue}>
                  {formatRupiah(item.revenue)}
                </Text>
              </View>
            ))}
          </Card>

          <Button
            disabled={!stats}
            icon="printer-outline"
            loading={printing}
            onPress={() => void print()}
          >
            Cetak rekap
          </Button>
          {canExportReports(session) ? (
            <Button
              disabled={!stats || stats.transactionCount === 0}
              icon="file-delimited-outline"
              loading={exporting}
              onPress={() => void exportCsv()}
              variant="secondary"
            >
              Ekspor CSV
            </Button>
          ) : null}
          {printMessage ? (
            <Text
              accessibilityRole={
                printMessage.tone === "error" ? "alert" : "text"
              }
              style={
                printMessage.tone === "error" ? styles.error : styles.success
              }
            >
              {printMessage.text}
            </Text>
          ) : null}
        </>
      )}
    </AppScreen>
  );
}

const baseStyles = themed(({ colors, textStyles }) =>
  StyleSheet.create({
    warning: {
      backgroundColor: colors.warningSoft,
      borderColor: colors.warning,
    },
    warningText: { ...textStyles.body, color: colors.warning },
    summary: { gap: spacing.xs },
    label: { ...textStyles.label },
    gross: { ...textStyles.price },
    meta: { ...textStyles.body, color: colors.textMuted },
    methodRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
    method: { flexGrow: 1, flexBasis: "45%", gap: spacing.xs },
    methodValue: {
      fontFamily: typography.heading,
      fontSize: 20,
      color: colors.text,
    },
    tableTitle: {
      paddingHorizontal: spacing.md,
      paddingTop: spacing.md,
    },
    packageRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderBottomColor: colors.outline,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    accent: { width: 4, alignSelf: "stretch", borderRadius: radius.pill },
    packageCopy: { flex: 1 },
    packageName: {
      ...textStyles.body,
      fontFamily: typography.bodySemibold,
    },
    packageRevenue: {
      ...textStyles.body,
      fontFamily: typography.bodySemibold,
      textAlign: "right",
    },
    error: { ...textStyles.body, color: colors.error },
    success: { ...textStyles.body, color: colors.success },
  }),
);
