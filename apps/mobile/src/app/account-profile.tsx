import { Redirect, useRouter } from "expo-router";
import { useState } from "react";
import { StyleSheet, Text } from "react-native";

import { useAuth } from "@/auth/AuthProvider";
import { AppScreen } from "@/components/layout/AppScreen";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { colors, spacing, textStyles } from "@/theme/tokens";
import { toUserFacingErrorMessage } from "@/utils/errors";
import {
  useResponsiveStyles,
  useResponsiveTextStyles,
} from "@/theme/responsive";

export default function AccountProfileScreen() {
  const { session, scopeLocked, updateProfile } = useAuth();
  const router = useRouter();
  const styles = useResponsiveStyles(baseStyles);
  const textStyles = useResponsiveTextStyles();
  const [fullName, setFullName] = useState(session?.user.fullName ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!session) return <Redirect href="/(auth)/login" />;
  if (session.user.mustChangePassword)
    return <Redirect href="/(auth)/change-password" />;
  if (scopeLocked) return <Redirect href="/contexts" />;
  const readOnly = session.dataMode === "sandbox";

  return (
    <AppScreen>
      <PageHeader
        back
        title="Akun saya"
        subtitle="Satu profil untuk semua bisnis Anda"
      />
      <Card style={styles.card}>
        <Text style={textStyles.body}>@{session.user.username}</Text>
        <Field
          label="Nama lengkap"
          value={fullName}
          editable={!readOnly && !busy}
          onChangeText={setFullName}
        />
        <Text style={styles.note}>
          Peran dan status akun berlaku untuk seluruh bisnis dan dikelola oleh
          Superadmin Pengelola Wisata Telomoyo.
        </Text>
        {readOnly ? (
          <Text style={styles.note}>
            Beralih ke Mode Produksi untuk mengubah akun.
          </Text>
        ) : (
          <Button
            loading={busy}
            disabled={!fullName.trim()}
            onPress={() => {
              if (busy) return;
              setBusy(true);
              setError(null);
              setMessage(null);
              void updateProfile(fullName)
                .then(() =>
                  setMessage("Nama akun diperbarui di seluruh bisnis."),
                )
                .catch((reason) =>
                  setError(
                    toUserFacingErrorMessage(
                      reason,
                      "Profil belum dapat disimpan.",
                    ),
                  ),
                )
                .finally(() => setBusy(false));
            }}
          >
            Simpan nama
          </Button>
        )}
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
        {message ? (
          <Text accessibilityRole="alert" style={styles.note}>
            {message}
          </Text>
        ) : null}
      </Card>
      {!readOnly ? (
        <Button
          variant="secondary"
          onPress={() => router.push("/account-password")}
        >
          Ganti kata sandi
        </Button>
      ) : null}
    </AppScreen>
  );
}

const baseStyles = StyleSheet.create({
  card: { gap: spacing.md },
  note: { ...textStyles.body, color: colors.textMuted },
  error: { ...textStyles.body, color: colors.error },
});
