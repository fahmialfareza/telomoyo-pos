import {
  useResponsiveStyles,
  useResponsiveTextStyles,
} from "@/theme/responsive";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "expo-router";
import { Controller, useForm } from "react-hook-form";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { z } from "zod";

import { useAuth } from "@/auth/AuthProvider";
import { AppScreen } from "@/components/layout/AppScreen";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import {
  colors,
  radius,
  spacing,
  textStyles,
  typography,
} from "@/theme/tokens";

const loginSchema = z.object({
  username: z.string().trim().min(1, "Nama pengguna wajib diisi."),
  password: z.string().min(1, "Kata sandi wajib diisi."),
});

type LoginForm = z.infer<typeof loginSchema>;

export default function LoginScreen() {
  const responsive = useResponsiveStyles(styles);
  const responsiveText = useResponsiveTextStyles();
  const router = useRouter();
  const { bootError, demoEnabled, demoLogin, login, notice } = useAuth();
  const {
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
    defaultValues: { username: "", password: "" },
  });

  const submit = handleSubmit(async (values) => {
    try {
      await login(values.username, values.password);
      router.replace("/");
    } catch (error) {
      setError("root", {
        message: error instanceof Error ? error.message : "Tidak dapat masuk.",
      });
    }
  });

  const loginAsDemo = async (role: "admin" | "superadmin") => {
    await demoLogin(role);
    router.replace("/");
  };

  return (
    <AppScreen authenticated={false} contentStyle={responsive.screen}>
      <View style={responsive.brand}>
        <View style={responsive.logo}>
          <Image
            accessibilityIgnoresInvertColors
            accessibilityLabel="Logo Telomoyo POS"
            source={require("../../../assets/branding/logo-mark.png")}
            style={responsive.logoMark}
          />
        </View>
        <Text style={responsive.brandName}>Telomoyo POS</Text>
        <Text style={responsive.tagline}>Sistem Point of Sale</Text>
      </View>

      <Card style={responsive.form}>
        <Text style={responsiveText.heading}>Masuk ke terminal</Text>
        <Text style={responsive.help}>
          Login pertama memerlukan internet. Sesi yang sudah tersimpan dapat
          dibuka kembali saat offline.
        </Text>
        {notice ? (
          <Text accessibilityRole="alert" style={responsive.notice}>
            {notice}
          </Text>
        ) : null}
        {bootError ? (
          <Text accessibilityRole="alert" style={responsive.error}>
            Penyimpanan lokal belum dapat dibuka: {bootError}
          </Text>
        ) : null}
        <Controller
          control={control}
          name="username"
          render={({ field: { onBlur, onChange, value } }) => (
            <Field
              autoCapitalize="none"
              autoComplete="username"
              error={errors.username?.message}
              label="Nama pengguna"
              onBlur={onBlur}
              onChangeText={onChange}
              placeholder="Masukkan nama pengguna"
              returnKeyType="next"
              value={value}
            />
          )}
        />
        <Controller
          control={control}
          name="password"
          render={({ field: { onBlur, onChange, value } }) => (
            <Field
              autoComplete="current-password"
              error={errors.password?.message}
              label="Kata sandi"
              onBlur={onBlur}
              onChangeText={onChange}
              onSubmitEditing={() => void submit()}
              placeholder="Masukkan kata sandi"
              returnKeyType="go"
              secureTextEntry
              value={value}
            />
          )}
        />
        {errors.root?.message ? (
          <Text accessibilityRole="alert" style={responsive.error}>
            {errors.root.message}
          </Text>
        ) : null}
        <Button
          icon="login"
          loading={isSubmitting}
          onPress={() => void submit()}
        >
          Masuk
        </Button>
      </Card>

      {demoEnabled ? (
        <Card style={responsive.demo}>
          <Text style={responsive.demoLabel}>KHUSUS DEVELOPMENT BUILD</Text>
          <Text style={responsive.help}>
            Sesi demo tidak menghubungi backend dan tidak tersedia pada preview
            atau production.
          </Text>
          <View style={responsive.demoActions}>
            <Button
              onPress={() => void loginAsDemo("admin")}
              style={responsive.demoButton}
              variant="secondary"
            >
              Demo Admin
            </Button>
            <Button
              onPress={() => void loginAsDemo("superadmin")}
              style={responsive.demoButton}
              variant="secondary"
            >
              Demo Superadmin
            </Button>
          </View>
        </Card>
      ) : null}

      <Pressable accessibilityRole="text" style={responsive.footer}>
        <Text style={responsive.footerText}>
          ANDROID POS • DATABASE TERENKRIPSI
        </Text>
      </Pressable>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  screen: {
    flexGrow: 1,
    justifyContent: "center",
    gap: spacing.lg,
  },
  brand: { alignItems: "center", gap: spacing.xs },
  logo: {
    width: 76,
    height: 76,
    borderRadius: radius.xl,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.sm,
  },
  logoMark: {
    width: 72,
    height: 72,
  },
  brandName: {
    fontFamily: typography.heading,
    fontSize: 28,
    color: colors.primary,
  },
  tagline: { ...textStyles.body, color: colors.textMuted },
  form: { gap: spacing.md },
  help: { ...textStyles.body, color: colors.textMuted },
  error: { ...textStyles.body, color: colors.error },
  notice: {
    ...textStyles.body,
    color: colors.warning,
    backgroundColor: colors.warningSoft,
    padding: spacing.sm,
    borderRadius: radius.md,
  },
  demo: { gap: spacing.sm, backgroundColor: colors.primarySoft },
  demoLabel: { ...textStyles.label, color: colors.primary },
  demoActions: { flexDirection: "row", gap: spacing.sm },
  demoButton: { flex: 1 },
  footer: { alignItems: "center" },
  footerText: { ...textStyles.label, fontSize: 10 },
});
