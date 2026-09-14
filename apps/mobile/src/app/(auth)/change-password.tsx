import {
  useResponsiveStyles,
  useResponsiveTextStyles,
} from "@/theme/responsive";
import { useRouter } from "expo-router";
import { useState } from "react";
import { StyleSheet, Text } from "react-native";

import { useAuth } from "@/auth/AuthProvider";
import { PasswordForm } from "@/components/forms/PasswordForm";
import { AppScreen } from "@/components/layout/AppScreen";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { StateView } from "@/components/ui/StateView";
import { colors, spacing, textStyles } from "@/theme/tokens";

export default function ForcedPasswordScreen() {
  const responsive = useResponsiveStyles(styles);
  const responsiveText = useResponsiveTextStyles();
  const router = useRouter();
  const { changePassword, session, switchMode, switchingMode } = useAuth();
  const [modeError, setModeError] = useState<string | null>(null);

  if (session?.dataMode === "sandbox") {
    return (
      <AppScreen contentStyle={responsive.screen}>
        <StateView
          icon="shield-lock-outline"
          message="Kata sandi hanya dapat diganti dari Mode Produksi. Kembali ke Produksi untuk melanjutkan."
          title="Perubahan akun dibatasi"
        />
        <Button
          loading={switchingMode}
          onPress={() => {
            setModeError(null);
            void switchMode("production").catch((reason: unknown) =>
              setModeError(
                reason instanceof Error
                  ? reason.message
                  : "Mode Produksi belum dapat dibuka.",
              ),
            );
          }}
        >
          Kembali ke Mode Produksi
        </Button>
        {modeError ? (
          <Text accessibilityRole="alert" style={responsive.error}>
            {modeError}
          </Text>
        ) : null}
      </AppScreen>
    );
  }

  return (
    <AppScreen authenticated={false} contentStyle={responsive.screen}>
      <Text style={responsiveText.title}>Buat kata sandi baru</Text>
      <Text style={responsive.subtitle}>
        Kata sandi sementara harus diganti sebelum terminal dapat digunakan.
        Langkah ini memerlukan internet.
      </Text>
      <Card style={responsive.card}>
        <PasswordForm
          onSubmit={async (current, next) => {
            await changePassword(current, next);
            router.replace("/");
          }}
          submitLabel="Aktifkan kata sandi"
        />
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
