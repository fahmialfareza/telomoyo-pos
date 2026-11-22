import Constants from "expo-constants";
import { useRouter } from "expo-router";
import * as Updates from "expo-updates";
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
import { ManagedTenantsScreen } from "@/tenant/screens";
import { useResponsiveStyles, themed } from "@/theme/responsive";
import {
  useAppearancePreference,
  type AppearancePreference,
} from "@/theme/ThemeContext";
import { radius, spacing, typography } from "@/theme/tokens";
import { initials } from "@/utils/format";

const appVersion = Constants.expoConfig?.version ?? "0.2.0";

const appearanceOptions: {
  value: AppearancePreference;
  title: string;
  detail?: string;
  icon: "theme-light-dark" | "white-balance-sunny" | "weather-night";
}[] = [
  {
    value: "system",
    title: "Ikuti sistem",
    detail: "Terang atau gelap mengikuti pengaturan Android",
    icon: "theme-light-dark",
  },
  { value: "light", title: "Terang", icon: "white-balance-sunny" },
  { value: "dark", title: "Gelap", icon: "weather-night" },
];

export default function SettingsScreen() {
  const styles = useResponsiveStyles(baseStyles);
  const router = useRouter();
  const { session, logout } = useAuth();
  const navigation = useContextNavigation();
  const { confirm } = useConfirmation();
  const [error, setError] = useState<string | null>(null);
  const [showTenants, setShowTenants] = useState(false);
  const appearance = useAppearancePreference();
  const { isUpdatePending } = Updates.useUpdates();

  if (showTenants) {
    return <ManagedTenantsScreen onBack={() => setShowTenants(false)} />;
  }

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
              {session?.user.role === "superadmin" ? "Superadmin" : "Admin"}
            </Text>
          </View>
        </View>
      </Card>

      <ModeOperationCard />
      <Text style={styles.section}>Bisnis & tenant</Text>
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
            onPress={() => setShowTenants(true)}
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

      <Text style={styles.section}>Akun & keamanan</Text>
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
      <Text style={styles.section}>Tampilan</Text>
      <Card padded={false}>
        {appearanceOptions.map((option) => (
          <MenuRow
            key={option.value}
            icon={option.icon}
            title={option.title}
            {...(option.detail ? { detail: option.detail } : {})}
            selected={appearance.preference === option.value}
            onPress={() => appearance.setPreference(option.value)}
          />
        ))}
      </Card>
      <Text style={styles.section}>Terminal</Text>
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
      {isUpdatePending ? (
        <Card padded={false}>
          <MenuRow
            detail="Mulai ulang aplikasi untuk memakai versi terbaru"
            icon="download-circle-outline"
            onPress={() =>
              confirm({
                title: "Pasang pembaruan sekarang?",
                message:
                  "Aplikasi akan dimulai ulang. Pastikan tidak ada transaksi yang sedang dibuat.",
                confirmLabel: "Mulai ulang",
                onConfirm: () => Updates.reloadAsync(),
              })
            }
            status="Pembaruan siap dipasang"
            title="Pembaruan aplikasi"
          />
        </Card>
      ) : null}
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
      <Text style={styles.version}>Telomoyo POS · v{appVersion}</Text>
    </AppScreen>
  );
}

const baseStyles = themed(({ colors, textStyles }) =>
  StyleSheet.create({
    profile: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
    },
    avatar: {
      width: 56,
      height: 56,
      borderRadius: radius.pill,
      backgroundColor: colors.primarySoft,
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
      fontFamily: typography.headingSemibold,
      color: colors.text,
      fontSize: 17,
    },
    username: { ...textStyles.body, fontSize: 14, color: colors.textMuted },
    role: {
      marginTop: spacing.xs,
      backgroundColor: colors.container,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.sm,
      paddingVertical: 4,
      alignSelf: "flex-start",
    },
    roleText: { ...textStyles.label, fontSize: 12 },
    section: {
      ...textStyles.label,
      marginTop: spacing.sm,
      marginBottom: -spacing.sm,
      paddingHorizontal: spacing.xs,
    },
    error: { ...textStyles.body, color: colors.error },
    version: {
      ...textStyles.label,
      textAlign: "center",
      marginTop: spacing.lg,
    },
  }),
);
