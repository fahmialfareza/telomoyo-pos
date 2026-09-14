import { useResponsiveStyles } from "@/theme/responsive";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { apiRequest } from "@/api/client";
import type {
  SandboxResetResponse,
  SandboxStatusResponse,
} from "@/api/contracts";
import { useAuth } from "@/auth/AuthProvider";
import { useSyncRuntime } from "@/sync/SyncProvider";
import { colors, radius, spacing, textStyles } from "@/theme/tokens";
import { toUserFacingErrorMessage } from "@/utils/errors";

import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Field } from "../ui/Field";

const RESET_CONFIRMATION = "RESET SANDBOX";

export function ModeOperationCard() {
  const responsive = useResponsiveStyles(styles);
  const { session, switchMode, upgradeSession, switchingMode } = useAuth();
  const sync = useSyncRuntime();
  const [status, setStatus] = useState<SandboxStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [resetExpanded, setResetExpanded] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [resetting, setResetting] = useState(false);
  const requestSequence = useRef(0);
  const token = session?.token;

  const loadStatus = useCallback(async () => {
    const request = ++requestSequence.current;
    if (!token || token.startsWith("dev-only-")) {
      setStatus(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await apiRequest<SandboxStatusResponse>("/sandbox/status", {
        token,
      });
      if (request !== requestSequence.current) return;
      setStatus(next);
      setError(null);
    } catch (reason) {
      if (request !== requestSequence.current) return;
      setError(
        toUserFacingErrorMessage(
          reason,
          "Status Mode Uji belum dapat dimuat. Coba lagi.",
        ),
      );
    } finally {
      if (request === requestSequence.current) setLoading(false);
    }
  }, [token]);

  useFocusEffect(
    useCallback(() => {
      void loadStatus();
      return () => {
        requestSequence.current += 1;
      };
    }, [loadStatus]),
  );

  if (!session) return null;

  const sandbox = session.dataMode === "sandbox";
  const needsUpgrade =
    (session.protocolVersion ?? 2) < 3 ||
    session.sandboxQrisPolicy !== "transaction_total";
  const targetMode = sandbox ? "production" : "sandbox";
  const canReset =
    session.user.role === "superadmin" &&
    session.dataMode === "production" &&
    status?.enabled === true &&
    status.generation !== null;

  const changeMode = async () => {
    setError(null);
    setMessage(null);
    try {
      await switchMode(targetMode);
      await sync.refresh();
    } catch (reason) {
      setError(
        toUserFacingErrorMessage(
          reason,
          "Mode operasi belum dapat diganti. Coba lagi.",
        ),
      );
    }
  };

  const resetSandbox = async () => {
    if (!canReset || status.generation === null) return;
    setResetting(true);
    setError(null);
    setMessage(null);
    try {
      const result = await apiRequest<SandboxResetResponse>("/sandbox/reset", {
        method: "POST",
        token: session.token,
        body: {
          expectedGeneration: status.generation,
          confirmation: RESET_CONFIRMATION,
        },
      });
      setConfirmation("");
      setResetExpanded(false);
      setMessage(
        `Mode Uji direset ke generasi ${result.current.generation}. ${result.clonedPackageCount} paket produksi disalin.`,
      );
      await loadStatus();
    } catch (reason) {
      setError(
        toUserFacingErrorMessage(
          reason,
          "Mode Uji belum dapat direset. Muat ulang status dan coba lagi.",
        ),
      );
    } finally {
      setResetting(false);
    }
  };

  return (
    <Card
      style={[responsive.card, ...(sandbox ? [responsive.sandboxCard] : [])]}
    >
      <View style={responsive.header}>
        <View style={responsive.copy}>
          <Text style={responsive.label}>MODE OPERASI</Text>
          <Text style={responsive.title}>
            {sandbox ? "Mode Uji" : "Mode Produksi"}
          </Text>
        </View>
        <View style={[responsive.badge, sandbox && responsive.sandboxBadge]}>
          <Text
            style={[
              responsive.badgeText,
              sandbox && responsive.sandboxBadgeText,
            ]}
          >
            {sandbox ? "UJI" : "LIVE"}
          </Text>
        </View>
      </View>

      <Text style={responsive.description}>
        {sandbox
          ? needsUpgrade
            ? "Sesi lama perlu diperbarui sebelum membuat atau mengoreksi transaksi Mode Uji. Pembayaran lama tetap memakai nominal aslinya."
            : "Data terisolasi dari laporan produksi. QRIS nyata memakai total transaksi dari harga paket Mode Uji dan mengirim uang sungguhan ke merchant."
          : "Transaksi, laporan, dan konfigurasi di mode ini adalah data operasional resmi."}
      </Text>
      {needsUpgrade ? (
        <Button
          variant="secondary"
          loading={switchingMode}
          disabled={resetting}
          onPress={() =>
            void (async () => {
              setError(null);
              try {
                await upgradeSession();
              } catch (reason) {
                setError(
                  toUserFacingErrorMessage(
                    reason,
                    "Sesi belum dapat diperbarui. Coba lagi.",
                  ),
                );
              }
            })()
          }
        >
          Perbarui sesi Mode Uji
        </Button>
      ) : null}
      {sandbox && session.sandboxGeneration ? (
        <Text style={responsive.generation}>
          GENERASI UJI {session.sandboxGeneration}
        </Text>
      ) : null}

      <Button
        disabled={
          loading || (!sandbox && status?.enabled !== true) || sync.syncing
        }
        loading={switchingMode}
        onPress={() => void changeMode()}
        variant={sandbox ? "primary" : "secondary"}
      >
        {sandbox ? "Kembali ke Produksi" : "Masuk ke Mode Uji"}
      </Button>
      {sync.pendingCount > 0 ? (
        <Text style={responsive.hint}>
          {sync.pendingCount} operasi akan disinkronkan sebelum mode diganti.
        </Text>
      ) : null}
      {!loading && !sandbox && status?.enabled === false ? (
        <Text style={responsive.hint}>
          Mode Uji belum diaktifkan pada server produksi.
        </Text>
      ) : null}

      {canReset ? (
        resetExpanded ? (
          <View style={responsive.resetPanel}>
            <Text style={responsive.resetTitle}>
              Reset seluruh data Mode Uji
            </Text>
            <Text style={responsive.hint}>
              Perangkat offline akan kehilangan generasi lama. Pembayaran QRIS
              nyata dengan nominal transaksi masing-masing tetap perlu
              direkonsiliasi. Ketik {RESET_CONFIRMATION}
              untuk melanjutkan.
            </Text>
            <Field
              autoCapitalize="characters"
              label="Konfirmasi reset"
              onChangeText={setConfirmation}
              placeholder={RESET_CONFIRMATION}
              value={confirmation}
            />
            <View style={responsive.actions}>
              <Button
                disabled={resetting}
                onPress={() => {
                  setConfirmation("");
                  setResetExpanded(false);
                }}
                style={responsive.action}
                variant="danger"
              >
                Batal
              </Button>
              <Button
                disabled={confirmation.trim() !== RESET_CONFIRMATION}
                loading={resetting}
                onPress={() => void resetSandbox()}
                style={responsive.action}
                variant="dangerSolid"
              >
                Reset Mode Uji
              </Button>
            </View>
          </View>
        ) : (
          <Button onPress={() => setResetExpanded(true)} variant="danger">
            Reset data Mode Uji
          </Button>
        )
      ) : null}
      {message ? <Text style={responsive.success}>{message}</Text> : null}
      {error ? (
        <Text accessibilityRole="alert" style={responsive.error}>
          {error}
        </Text>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing.md },
  sandboxCard: {
    backgroundColor: colors.warningSoft,
    borderColor: colors.warning,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  copy: { flex: 1 },
  label: { ...textStyles.label, color: colors.primary, fontSize: 10 },
  title: { ...textStyles.heading, marginTop: 2 },
  description: { ...textStyles.body, color: colors.textMuted },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.successSoft,
  },
  sandboxBadge: { backgroundColor: colors.warning },
  badgeText: { ...textStyles.label, color: colors.success, fontSize: 10 },
  sandboxBadgeText: { color: colors.onPrimary },
  generation: { ...textStyles.technical, color: colors.warning },
  hint: { ...textStyles.body, color: colors.textMuted, fontSize: 12 },
  resetPanel: {
    gap: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.warning,
  },
  resetTitle: { ...textStyles.heading, color: colors.error },
  actions: { flexDirection: "row", gap: spacing.sm },
  action: { flex: 1 },
  success: { ...textStyles.body, color: colors.success },
  error: { ...textStyles.body, color: colors.error },
});
