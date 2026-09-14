import {
  useResponsiveStyles,
  useResponsiveTextStyles,
} from "@/theme/responsive";
import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";

import { useAuth } from "@/auth/AuthProvider";
import { AppScreen } from "@/components/layout/AppScreen";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import {
  colors,
  radius,
  spacing,
  textStyles,
  typography,
} from "@/theme/tokens";
import { initials } from "@/utils/format";

export default function ProfileScreen() {
  const responsive = useResponsiveStyles(styles);
  const { session } = useAuth();
  const router = useRouter();
  if (!session) return <AppScreen />;
  return (
    <AppScreen>
      <PageHeader back title="Profil" />
      <Card style={responsive.profile}>
        <View style={responsive.avatar}>
          <Text style={responsive.avatarText}>
            {initials(session.user.fullName)}
          </Text>
        </View>
        <Text style={responsive.name}>{session.user.fullName}</Text>
        <Text style={responsive.username}>@{session.user.username}</Text>
      </Card>
      <Card style={responsive.details}>
        <Row label="ID pengguna" value={session.user.id} />
        <Row label="Peran" value={session.user.role.toUpperCase()} />
        <Row
          label="Status"
          value={session.user.active ? "AKTIF" : "NONAKTIF"}
        />
        <Row label="ID sesi" value={session.sessionId} />
      </Card>
      <Text style={responsive.note}>
        {session.dataMode === "sandbox"
          ? "Profil ini digunakan bersama dengan Produksi dan hanya dapat diubah dari Mode Produksi."
          : "Nama dan kata sandi hanya dapat diubah oleh pemilik akun. Peran dikelola terpisah oleh superadmin setiap bisnis."}
      </Text>
      <Button
        disabled={session.dataMode === "sandbox"}
        onPress={() => router.push("/account-profile")}
      >
        Kelola akun saya
      </Button>
    </AppScreen>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  const responsive = useResponsiveStyles(styles);
  const responsiveText = useResponsiveTextStyles();
  return (
    <View style={responsive.row}>
      <Text style={responsiveText.label}>{label.toUpperCase()}</Text>
      <Text selectable style={responsive.value}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  profile: { alignItems: "center", gap: spacing.xs },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: radius.lg,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    fontFamily: typography.heading,
    fontSize: 22,
    color: colors.onPrimary,
  },
  name: { ...textStyles.heading, marginTop: spacing.sm },
  username: { ...textStyles.body, color: colors.textMuted },
  details: { gap: spacing.md },
  row: { gap: spacing.xs },
  value: { ...textStyles.body, fontFamily: typography.bodyMedium },
  note: { ...textStyles.body, color: colors.textMuted, textAlign: "center" },
});
