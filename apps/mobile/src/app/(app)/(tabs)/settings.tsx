import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { useAuth } from "@/auth/AuthProvider";
import { toUserFacingErrorMessage } from "@/utils/errors";
import { AppScreen } from "@/components/layout/AppScreen";
import { PageHeader } from "@/components/layout/PageHeader";
import { ModeOperationCard } from "@/components/settings/ModeOperationCard";
import { Card } from "@/components/ui/Card";
import { MenuRow } from "@/components/ui/MenuRow";
import { useConfirmation } from "@/components/ui/ConfirmationProvider";
import { useContextNavigation } from "@/navigation/context-navigation";
import { useResponsiveStyles } from "@/theme/responsive";
import {
  colors,
  radius,
  spacing,
  textStyles,
  typography,
} from "@/theme/tokens";
import { initials } from "@/utils/format";

const appVersion = Constants.expoConfig?.version ?? "0.2.0";

export default function SettingsScreen() {
  const styles = useResponsiveStyles(baseStyles);
  const router = useRouter();
  const { session, logout } = useAuth();
  const navigation = useContextNavigation();
  const { confirm } = useConfirmation();
  const [error, setError] = useState<string | null>(null);

  return (
    <AppScreen>
      <PageHeader title="Pengaturan" />
      <Card style={styles.profile}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>
            {initials(session?.user.fullName ?? "POS")}
          </Text>
        </View>
        <View style={styles.profileCopy}>
          <Text style={styles.name}>{session?.user.fullName}</Text>
          <Text style={styles.username}>@{session?.user.username}</Text>
          <View style={styles.role}>
            <Text style={styles.roleText}>
              {session?.user.role === "superadmin" ? "SUPERADMIN" : "ADMIN"}
            </Text>
          </View>
        </View>
      </Card>

      <ModeOperationCard />
      <Text style={styles.section}>BISNIS & TENANT</Text>
      <Card padded={false}>
        <MenuRow
          icon="store-outline"
          title="Ganti bisnis"
          detail={session?.tenant?.name ?? "Pilih bisnis aktif"}
          onPress={() => router.push("/contexts")}
        />
        {session?.user.role === "superadmin" ? (
          <MenuRow
            icon="store-cog-outline"
            title="Kelola tenant"
            detail="Tambah bisnis, ubah nama, tangguhkan atau aktifkan"
            onPress={() =>
              void navigation.openManagement("/management/tenants")
            }
          />
        ) : null}
        {session?.user.role === "superadmin" &&
        session.dataMode === "production" ? (
          <MenuRow
            icon="card-account-details-outline"
            title="Identitas struk"
            detail="Nama, alamat, dan telepon pada struk"
            onPress={() => router.push("/settings/business")}
          />
        ) : null}
      </Card>

      <Text style={styles.section}>AKUN & KEAMANAN</Text>
      <Card padded={false}>
        <MenuRow
          icon="account-outline"
          onPress={() => router.push("/settings/profile")}
          title="Profil"
        />
        {session?.dataMode === "production" ? (
          <MenuRow
            icon="lock-outline"
            onPress={() => router.push("/account-password")}
            title="Ganti kata sandi"
          />
        ) : null}
      </Card>
      <Text style={styles.section}>TERMINAL</Text>
      <Card padded={false}>
        <MenuRow
          detail="Bluetooth, printer MPOS, dan lebar kertas"
          icon="printer-outline"
          onPress={() => router.push("/settings/printer")}
          title="Pengaturan printer"
        />
        {session?.user.role === "superadmin" &&
        session.dataMode === "production" ? (
          <MenuRow
            detail="Payload merchant untuk nominal QRIS otomatis"
            icon="qrcode"
            onPress={() => router.push("/settings/qris")}
            title="QRIS dinamis"
          />
        ) : null}
        <MenuRow
          detail="Outbox, konflik, dan sinkron manual"
          icon="sync"
          onPress={() => router.push("/sync")}
          title="Sinkronisasi data"
        />
        {session?.user.role === "superadmin" ? (
          <MenuRow
            detail="Harga baru hanya berlaku untuk transaksi baru"
            icon="tag-outline"
            onPress={() => router.push("/packages")}
            title="Paket & harga"
          />
        ) : null}
      </Card>
      <Card padded={false}>
        <MenuRow
          destructive
          icon="logout"
          onPress={() => {
            if (navigation.busy) return;
            confirm({
              title: "Keluar dari akun?",
              message:
                "Anda perlu masuk kembali untuk menggunakan aplikasi. Data yang belum tersinkron tetap disimpan pada perangkat.",
              confirmLabel: "Keluar",
              destructive: true,
              onConfirm: async () => {
                setError(null);
                try {
                  await logout();
                } catch (reason) {
                  setError(
                    toUserFacingErrorMessage(
                      reason,
                      "Belum dapat keluar dari akun. Coba lagi.",
                    ),
                  );
                }
              },
            });
          }}
          title="Keluar"
        />
      </Card>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      <Text style={styles.version}>TELOMOYO POS • v{appVersion}</Text>
    </AppScreen>
  );
}

const baseStyles = StyleSheet.create({
  profile: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: radius.lg,
    backgroundColor: colors.onPrimary,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    fontFamily: typography.heading,
    fontSize: 18,
    color: colors.primary,
  },
  profileCopy: { flex: 1, gap: 2 },
  name: {
    fontFamily: typography.heading,
    color: colors.onPrimary,
    fontSize: 18,
  },
  username: { ...textStyles.body, color: colors.primarySoft },
  role: {
    marginTop: spacing.xs,
    backgroundColor: colors.onPrimary,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    alignSelf: "flex-start",
  },
  roleText: { ...textStyles.label, color: colors.primary, fontSize: 10 },
  section: textStyles.label,
  error: { ...textStyles.body, color: colors.error },
  version: { ...textStyles.label, textAlign: "center", marginTop: spacing.lg },
});
