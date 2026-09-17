import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { BackHandler, StyleSheet, Text, View } from "react-native";

import { useAuth } from "@/auth/AuthProvider";
import { AppScreen } from "@/components/layout/AppScreen";
import { PageHeader } from "@/components/layout/PageHeader";
import { ReceiptPreview } from "@/components/transactions/ReceiptPreview";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ActionGroup } from "@/components/ui/ActionGroup";
import { PaymentMethodBadge } from "@/components/ui/PaymentBadge";
import { StateView } from "@/components/ui/StateView";
import {
  beginPrintAttempt,
  completePrintAttempt,
  getTransaction,
} from "@/db/repositories";
import type { Transaction } from "@/domain/types";
import { getConfiguredPrinter } from "@/printer/service";
import { receiptFromTransaction, type ReceiptDocument } from "@/printer/types";
import { readPrinterConfig, type PrinterConfig } from "@/security/secure-store";
import { beginLocalMutation } from "@/mode/mutation-barrier";
import { useModeStore } from "@/mode/mode-store";
import { useSyncRuntime } from "@/sync/SyncProvider";
import {
  colors,
  radius,
  spacing,
  textStyles,
  typography,
} from "@/theme/tokens";
import { displayTransactionId, formatRupiah } from "@/utils/format";
import {
  useResponsiveStyles,
  useResponsiveTextStyles,
} from "@/theme/responsive";

export default function PrintTransactionScreen() {
  const styles = useResponsiveStyles(baseStyles);
  const textStyles = useResponsiveTextStyles();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const sync = useSyncRuntime();
  const [transaction, setTransaction] = useState<Transaction | null>(null);
  const [printing, setPrinting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [printerConfig, setPrinterConfig] = useState<PrinterConfig | null>(
    null,
  );
  const [attemptDocument, setAttemptDocument] =
    useState<ReceiptDocument | null>(null);
  const [simulatedSuccess, setSimulatedSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeAttempt = useRef(false);

  useFocusEffect(
    useCallback(() => {
      // A physical printer must finish and release its mutation lease before
      // this screen is left. Read the ref to also cover the first tap frame.
      const listener = BackHandler.addEventListener(
        "hardwareBackPress",
        () => activeAttempt.current,
      );
      let current = true;
      void readPrinterConfig().then((config) => {
        if (current) setPrinterConfig(config);
      });
      return () => {
        current = false;
        listener.remove();
      };
    }, []),
  );

  useEffect(() => {
    let current = true;
    if (id && session) {
      void Promise.all([getTransaction(id, session), readPrinterConfig()])
        .then(([value, config]) => {
          if (!current) return;
          setTransaction(value);
          setPrinterConfig(config);
          if (!value) setError("Transaksi tidak ditemukan pada bisnis ini.");
        })
        .catch((reason) => {
          if (current)
            setError(
              reason instanceof Error
                ? reason.message
                : "Transaksi belum dapat dibaca.",
            );
        });
    }
    return () => {
      current = false;
    };
  }, [id, session]);

  if (!transaction || !session) {
    return (
      <AppScreen>
        <PageHeader back title="Cetak struk" />
        {error ? (
          <StateView
            icon="alert-circle-outline"
            title="Struk belum dapat dibuka"
            message={error}
          />
        ) : null}
      </AppScreen>
    );
  }
  const isCopy =
    transaction.printState === "success" ||
    transaction.printState === "unknown" ||
    transaction.printState === "needs-reprint";

  const print = async (forceCopy?: boolean) => {
    if (activeAttempt.current) return;
    activeAttempt.current = true;
    const printAsCopy = forceCopy ?? isCopy;
    setPrinting(true);
    setError(null);
    let attemptId: string | null = null;
    let mutationLease: (() => void) | undefined;
    let connectedPrinter:
      Awaited<ReturnType<typeof getConfiguredPrinter>>["printer"] | undefined;
    try {
      mutationLease = beginLocalMutation(session);
      const document = receiptFromTransaction(
        transaction,
        printAsCopy,
        session.dataMode,
      );
      for (const line of document.lines) Object.freeze(line);
      if (document.receiptIdentity) Object.freeze(document.receiptIdentity);
      Object.freeze(document.lines);
      Object.freeze(document);
      const { config, printer } = await getConfiguredPrinter();
      setPrinterConfig(config);
      setAttemptDocument(document);
      connectedPrinter = printer;
      attemptId = await beginPrintAttempt({
        transactionId: transaction.id,
        transactionRevision: transaction.revision,
        adapter: config.adapter,
        isCopy: printAsCopy,
        session,
        mutationLease,
      });
      await printer.connect(config.address ?? undefined);
      if (useModeStore.getState().accessBlocked)
        throw new Error(
          "Akses bisnis dihentikan. Pencetakan dibatalkan sebelum struk dikirim.",
        );
      const result = await printer.print(document);
      await printer.disconnect().catch(() => undefined);
      await completePrintAttempt({
        attemptId,
        transactionId: transaction.id,
        result: result.status,
        ...(result.status === "success" ? {} : { error: result.message }),
        session,
        mutationLease,
      });
      await sync.refresh();
      void sync.syncNow();
      if (result.status === "success") {
        setTransaction((current) =>
          current ? { ...current, printState: "success" } : current,
        );
        setSuccess(true);
        setSimulatedSuccess(config.adapter === "simulator");
      } else {
        router.replace({
          pathname: "/transactions/[id]/print-failure",
          params: {
            id: transaction.id,
            status: result.status,
            message: result.message,
          },
        });
      }
    } catch (reason) {
      const message =
        reason instanceof Error ? reason.message : "Printer gagal digunakan.";
      if (attemptId) {
        await completePrintAttempt({
          attemptId,
          transactionId: transaction.id,
          result: "failed",
          error: message,
          session,
          mutationLease,
        }).catch(() => undefined);
      }
      setError(message);
    } finally {
      await connectedPrinter?.disconnect().catch(() => undefined);
      mutationLease?.();
      activeAttempt.current = false;
      setPrinting(false);
    }
  };

  return (
    <AppScreen
      stickyFooter={
        <ActionGroup>
          {error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          ) : null}
          {success ? (
            <ActionGroup>
              <Button
                disabled={printing}
                icon="home-outline"
                onPress={() => {
                  if (!activeAttempt.current)
                    router.replace("/(app)/(tabs)/home");
                }}
              >
                Kembali ke Beranda
              </Button>
              <Button
                icon="printer-outline"
                disabled={printing}
                loading={printing}
                variant="secondary"
                onPress={() => {
                  setSuccess(false);
                  void print(true);
                }}
              >
                Cetak salinan
              </Button>
            </ActionGroup>
          ) : (
            <ActionGroup>
              <Button
                icon="printer-outline"
                disabled={!printerConfig}
                loading={printing}
                onPress={() => void print()}
              >
                {isCopy ? "Cetak salinan" : "Cetak struk"}
              </Button>
              <Button
                disabled={printing}
                onPress={() => {
                  if (!activeAttempt.current)
                    router.replace("/(app)/(tabs)/history");
                }}
                variant="secondary"
              >
                Cetak nanti
              </Button>
            </ActionGroup>
          )}
        </ActionGroup>
      }
    >
      <PageHeader
        back={!printing}
        title={
          success
            ? simulatedSuccess
              ? "Simulasi selesai"
              : "Struk tercetak"
            : "Cetak struk"
        }
      />
      <View style={[styles.icon, success && styles.iconSuccess]}>
        <Text style={styles.iconGlyph}>{success ? "✓" : "✓"}</Text>
      </View>
      <Text style={styles.title}>
        {success
          ? simulatedSuccess
            ? "Simulasi cetak berhasil"
            : "Struk berhasil dicetak!"
          : "Pembayaran berhasil"}
      </Text>
      <Text style={styles.subtitle}>
        {success
          ? simulatedSuccess
            ? "Simulator memproses struk tanpa mencetak kertas. Hasil simulasi masuk ke antrean sinkron."
            : "Penjualan tetap tercatat dan hasil cetak masuk ke antrean sinkron."
          : "Pembayaran sudah dikonfirmasi untuk revisi transaksi ini. Struk siap dicetak."}
      </Text>
      {session.dataMode === "sandbox" ? (
        <Card style={styles.testWarning}>
          <Text style={styles.testWarningTitle}>
            MODE UJI — BUKAN STRUK RESMI
          </Text>
          <Text style={styles.subtitle}>
            Semua jenis printer akan mencetak watermark Mode Uji dan ID
            TEST-TRX-.
          </Text>
        </Card>
      ) : null}
      <Card style={styles.summary}>
        <View testID="print-summary-header" style={styles.summaryHeader}>
          <Text style={styles.id}>
            {displayTransactionId(transaction.id, session.dataMode)}
          </Text>
          <PaymentMethodBadge method={transaction.paymentMethod} />
        </View>
        {transaction.items.map((item) => (
          <View key={item.id} style={styles.line}>
            <Text style={styles.lineName}>
              {item.quantity} × {item.name}
            </Text>
            <Text style={styles.lineValue}>{formatRupiah(item.lineTotal)}</Text>
          </View>
        ))}
        <View testID="print-summary-total" style={styles.total}>
          <Text style={textStyles.heading}>Total</Text>
          <Text style={[textStyles.price, styles.totalAmount]}>
            {formatRupiah(transaction.total)}
          </Text>
        </View>
        {session.dataMode === "sandbox" &&
        transaction.paymentMethod === "qris" ? (
          <View style={styles.line}>
            <Text style={styles.lineName}>QRIS nyata</Text>
            <Text style={styles.lineValue}>
              {formatRupiah(transaction.paymentAmount)}
            </Text>
          </View>
        ) : null}
      </Card>
      {printerConfig ? (
        <ReceiptPreview
          columns={printerConfig.paperColumns}
          document={
            attemptDocument ??
            receiptFromTransaction(transaction, isCopy, session.dataMode)
          }
        />
      ) : null}
    </AppScreen>
  );
}

const baseStyles = StyleSheet.create({
  icon: {
    width: 84,
    height: 84,
    borderRadius: radius.xl,
    backgroundColor: colors.primary,
    alignSelf: "center",
    alignItems: "center",
    justifyContent: "center",
  },
  iconSuccess: { backgroundColor: colors.success },
  iconGlyph: {
    fontFamily: typography.heading,
    fontSize: 46,
    color: colors.onPrimary,
  },
  title: { ...textStyles.title, textAlign: "center" },
  subtitle: {
    ...textStyles.body,
    color: colors.textMuted,
    textAlign: "center",
  },
  summary: { gap: spacing.sm },
  summaryHeader: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  id: {
    ...textStyles.technical,
    color: colors.primary,
    flexShrink: 1,
    maxWidth: "100%",
  },
  line: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  lineName: { ...textStyles.body, flex: 1 },
  lineValue: { ...textStyles.body, fontFamily: typography.bodySemibold },
  total: {
    marginTop: spacing.sm,
    paddingTop: spacing.md,
    borderTopColor: colors.outline,
    borderTopWidth: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    justifyContent: "space-between",
    alignItems: "center",
  },
  totalAmount: { flexShrink: 1, maxWidth: "100%" },
  error: {
    ...textStyles.body,
    color: colors.error,
    backgroundColor: colors.errorSoft,
    padding: spacing.md,
    borderRadius: radius.md,
  },
  testWarning: {
    gap: spacing.xs,
    backgroundColor: colors.warningSoft,
    borderColor: colors.warning,
  },
  testWarningTitle: {
    ...textStyles.heading,
    color: colors.warning,
    textAlign: "center",
  },
});
