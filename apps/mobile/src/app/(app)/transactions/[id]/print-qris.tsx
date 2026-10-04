import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, Text, View } from "react-native";

import { useAuth } from "@/auth/AuthProvider";
import { AppScreen } from "@/components/layout/AppScreen";
import { PageHeader } from "@/components/layout/PageHeader";
import { DynamicQrisCard } from "@/components/payments/DynamicQrisCard";
import { ActionGroup } from "@/components/ui/ActionGroup";
import { Button } from "@/components/ui/Button";
import { StateView } from "@/components/ui/StateView";
import { getTransaction, hasTerminalTransactionBlock } from "@/db/repositories";
import { isPaymentConfirmedForCurrentRevision } from "@/domain/payments";
import type { QrisPrintDocument } from "@/printer/types";
import { getConfiguredPrinter } from "@/printer/service";
import { beginLocalMutation } from "@/mode/mutation-barrier";
import { useModeStore } from "@/mode/mode-store";
import { qrisDocumentForTransaction } from "@/tenant/transaction-qris";
import { colors } from "@/theme/tokens";
import { formatRupiah } from "@/utils/format";

export default function PrintQrisScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const [document, setDocument] = useState<QrisPrintDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const activeAttempt = useRef(false);
  const autoPrintStarted = useRef(false);

  useEffect(() => {
    const listener = BackHandler.addEventListener(
      "hardwareBackPress",
      () => activeAttempt.current,
    );
    return () => listener.remove();
  }, []);

  useEffect(() => {
    let current = true;
    if (!id || !session) return;
    void (async () => {
      try {
        const transaction = await getTransaction(id, session);
        if (!transaction || transaction.paymentMethod !== "qris") {
          throw new Error("Transaksi QRIS tidak ditemukan pada bisnis ini.");
        }
        if (
          transaction.deletedAt !== null ||
          transaction.syncState === "conflict" ||
          (await hasTerminalTransactionBlock(id, session)) ||
          !isPaymentConfirmedForCurrentRevision(transaction)
        ) {
          throw new Error(
            "Transaksi ini belum dapat dicetak. Periksa status pembayaran dan sinkronisasi.",
          );
        }
        const qrisDocument = await qrisDocumentForTransaction(
          transaction,
          session,
        );
        if (current) {
          setDocument(qrisDocument);
        }
      } catch (reason) {
        if (current) {
          setError(
            reason instanceof Error
              ? reason.message
              : "QRIS tidak dapat disiapkan.",
          );
        }
      }
    })();
    return () => {
      current = false;
    };
  }, [id, session]);

  const printQris = async () => {
    if (!document || !session || activeAttempt.current) return;
    activeAttempt.current = true;
    setPrinting(true);
    setError(null);
    let release: (() => void) | undefined;
    let printer:
      Awaited<ReturnType<typeof getConfiguredPrinter>>["printer"] | undefined;
    try {
      release = beginLocalMutation(session);
      const configured = await getConfiguredPrinter();
      printer = configured.printer;
      await printer.connect(configured.config.address ?? undefined);
      if (useModeStore.getState().accessBlocked) {
        throw new Error("Akses bisnis dihentikan. QRIS tidak jadi dicetak.");
      }
      const result = await printer.printQris(Object.freeze({ ...document }));
      if (result.status !== "success") {
        throw new Error(result.message);
      }
      await printer.disconnect();
      printer = undefined;
      release();
      release = undefined;
      router.replace({
        pathname: "/transactions/[id]/print",
        params: { id: document.transactionId, autoPrint: "1" },
      });
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "QRIS gagal dicetak. Coba lagi sebelum mencetak struk.",
      );
    } finally {
      await printer?.disconnect().catch(() => undefined);
      release?.();
      activeAttempt.current = false;
      setPrinting(false);
    }
  };

  useEffect(() => {
    if (!document || autoPrintStarted.current) return;
    autoPrintStarted.current = true;
    void printQris();
  });

  return (
    <AppScreen
      stickyFooter={
        <ActionGroup>
          {error ? <Text accessibilityRole="alert">{error}</Text> : null}
          {document ? (
            <Button
              disabled={printing}
              icon="qrcode-scan"
              loading={printing}
              onPress={() => void printQris()}
            >
              {error ? "Coba lagi cetak QRIS" : "Cetak QRIS lalu struk"}
            </Button>
          ) : null}
        </ActionGroup>
      }
    >
      <PageHeader back={!printing} title="Cetak QRIS" />
      {document ? (
        <View>
          <DynamicQrisCard
            amount={document.paymentAmount}
            merchantCity={document.merchantCity}
            merchantName={document.merchantName}
            orderTotal={document.orderTotal}
            payload={document.payload}
            sandbox={document.dataMode === "sandbox"}
            error={null}
          />
          <Text>
            {printing
              ? "Mencetak QRIS pembayaran… struk akan dicetak sesudahnya."
              : `QRIS ${formatRupiah(document.paymentAmount)} siap dicetak.`}
          </Text>
        </View>
      ) : error ? (
        <StateView
          icon="alert-circle-outline"
          title="QRIS tidak dapat dicetak"
          message={error}
        />
      ) : (
        <View>
          <ActivityIndicator color={colors.primary} />
          <Text>Menyiapkan QRIS transaksi…</Text>
        </View>
      )}
    </AppScreen>
  );
}
