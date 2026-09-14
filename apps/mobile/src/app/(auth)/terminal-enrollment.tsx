import {
  useResponsiveStyles,
  useResponsiveTextStyles,
} from "@/theme/responsive";
import { useRouter } from "expo-router";
import { useState } from "react";
import { StyleSheet, Text } from "react-native";

import { useAuth } from "@/auth/AuthProvider";
import { AppScreen } from "@/components/layout/AppScreen";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { StateView } from "@/components/ui/StateView";
import { colors, spacing, textStyles } from "@/theme/tokens";

export default function TerminalEnrollmentScreen() {
  const responsive = useResponsiveStyles(styles);
  const responsiveText = useResponsiveTextStyles();
  const router = useRouter();
  const { enrollTerminal, session, switchMode, switchingMode, logout } =
    useAuth();
  const [label, setLabel] = useState("MPOS Utama");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (session?.user.role === "admin") {
    return (
      <AppScreen>
        <StateView
          icon="shield-lock-outline"
          title="Pendaftaran oleh Superadmin"
          message="Minta Superadmin masuk dan mendaftarkan perangkat untuk bisnis ini terlebih dahulu. Setelah itu, Admin dapat masuk dan bertransaksi dengan akunnya sendiri."
        />
        <Button variant="secondary" onPress={() => router.replace("/contexts")}>
          Ganti bisnis
        </Button>
        <Button
          loading={submitting}
          onPress={() => {
            setSubmitting(true);
            void logout()
              .then(() => router.replace("/(auth)/login"))
              .catch((reason: unknown) => {
                setError(
                  reason instanceof Error
                    ? reason.message
                    : "Belum dapat keluar. Coba lagi.",
                );
              })
              .finally(() => setSubmitting(false));
          }}
        >
          Keluar untuk masuk sebagai Superadmin
        </Button>
        {error ? (
          <Text accessibilityRole="alert" style={responsive.error}>
            {error}
          </Text>
        ) : null}
      </AppScreen>
    );
  }

  if (session?.dataMode === "sandbox") {
    return (
      <AppScreen>
        <StateView
          icon="shield-lock-outline"
          message="Terminal hanya dapat didaftarkan dari Mode Produksi. Kembali ke Produksi untuk melanjutkan."
          title="Tidak tersedia di Mode Uji"
        />
        <Button
          loading={switchingMode}
          onPress={() => {
            setError(null);
            void switchMode("production").catch((reason: unknown) =>
              setError(
                reason instanceof Error
                  ? reason.message
                  : "Mode Produksi belum dapat dibuka.",
              ),
            );
          }}
        >
          Kembali ke Mode Produksi
        </Button>
        {error ? (
          <Text accessibilityRole="alert" style={responsive.error}>
            {error}
          </Text>
        ) : null}
      </AppScreen>
    );
  }

  const submit = async () => {
    if (label.trim().length < 3) {
      setError("Nama terminal minimal 3 karakter.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await enrollTerminal(label);
      router.replace("/");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Pendaftaran terminal gagal.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AppScreen authenticated={false} contentStyle={responsive.screen}>
      <Text style={responsiveText.title}>Daftarkan terminal</Text>
      <Text style={responsive.subtitle}>
        Terminal membuat pasangan kunci Ed25519 yang tersimpan aman di
        perangkat. Pendaftaran pertama memerlukan internet.
      </Text>
      <Card style={responsive.card}>
        <Field
          error={error ?? undefined}
          label="Nama terminal"
          onChangeText={setLabel}
          value={label}
        />
        <Button
          icon="shield-key-outline"
          loading={submitting}
          onPress={() => void submit()}
        >
          Daftarkan terminal
        </Button>
      </Card>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  screen: { flexGrow: 1, justifyContent: "center" },
  subtitle: { ...textStyles.body, color: colors.textMuted },
  card: { gap: spacing.md },
  error: { ...textStyles.body, color: colors.error, textAlign: "center" },
});
