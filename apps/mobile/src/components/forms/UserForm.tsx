import {
  useResponsiveStyles,
  useResponsiveTextStyles,
} from "@/theme/responsive";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import type { Role } from "@/domain/types";
import {
  colors,
  radius,
  spacing,
  textStyles,
  typography,
} from "@/theme/tokens";

export interface UserFormValue {
  fullName: string;
  username: string;
  role: Role;
  temporaryPassword?: string;
  active: boolean;
}

export function UserForm({
  initial,
  create,
  onSubmit,
}: {
  initial?: Partial<UserFormValue>;
  create: boolean;
  onSubmit: (value: UserFormValue) => Promise<void>;
}) {
  const responsive = useResponsiveStyles(styles);
  const responsiveText = useResponsiveTextStyles();
  const [value, setValue] = useState<UserFormValue>({
    fullName: initial?.fullName ?? "",
    username: initial?.username ?? "",
    role: initial?.role ?? "admin",
    temporaryPassword: "",
    active: initial?.active ?? true,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (value.fullName.trim().length < 2) {
      setError("Nama lengkap minimal 2 karakter.");
      return;
    }
    if (!/^[a-z0-9._-]{3,64}$/.test(value.username)) {
      setError("Username hanya boleh memakai huruf kecil, angka, . _ atau -.");
      return;
    }
    if (create && (value.temporaryPassword?.length ?? 0) < 12) {
      setError("Kata sandi sementara minimal 12 karakter.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit(value);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Pengguna gagal disimpan.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Field
        label="Nama lengkap"
        onChangeText={(fullName) =>
          setValue((current) => ({ ...current, fullName }))
        }
        placeholder="Nama pengguna"
        value={value.fullName}
      />
      <Field
        autoCapitalize="none"
        label="Username"
        onChangeText={(username) =>
          setValue((current) => ({
            ...current,
            username: username.toLowerCase(),
          }))
        }
        placeholder="username"
        value={value.username}
      />
      {create ? (
        <Field
          hint="Pengguna wajib menggantinya saat login pertama."
          label="Kata sandi sementara"
          onChangeText={(temporaryPassword) =>
            setValue((current) => ({ ...current, temporaryPassword }))
          }
          secureTextEntry
          value={value.temporaryPassword}
        />
      ) : null}
      <Text style={responsiveText.label}>PERAN PENGGUNA</Text>
      <View style={responsive.options}>
        {(["admin", "superadmin"] as const).map((role) => (
          <Pressable
            key={role}
            onPress={() => setValue((current) => ({ ...current, role }))}
            style={[
              responsive.option,
              value.role === role && responsive.optionSelected,
            ]}
          >
            <Text
              style={[
                responsive.optionTitle,
                value.role === role && { color: colors.primary },
              ]}
            >
              {role === "superadmin" ? "Superadmin" : "Admin"}
            </Text>
            <Text style={responsive.optionDetail}>
              {role === "superadmin"
                ? "Kelola pengguna, paket, dan penghapusan."
                : "Transaksi, laporan, dan koreksi."}
            </Text>
          </Pressable>
        ))}
      </View>
      {!create ? (
        <>
          <Text style={responsiveText.label}>STATUS AKUN</Text>
          <Pressable
            onPress={() =>
              setValue((current) => ({ ...current, active: !current.active }))
            }
            style={[responsive.toggle, value.active && responsive.toggleActive]}
          >
            <Text
              style={[
                responsive.toggleText,
                value.active && { color: colors.success },
              ]}
            >
              {value.active ? "AKTIF" : "NONAKTIF"}
            </Text>
          </Pressable>
        </>
      ) : null}
      {error ? <Text style={responsive.error}>{error}</Text> : null}
      <Button
        icon="content-save-outline"
        loading={saving}
        onPress={() => void submit()}
      >
        {create ? "Simpan pengguna" : "Simpan perubahan"}
      </Button>
    </>
  );
}

const styles = StyleSheet.create({
  options: { flexDirection: "row", gap: spacing.sm },
  option: {
    flex: 1,
    minHeight: 112,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.outline,
    backgroundColor: colors.card,
    gap: spacing.xs,
  },
  optionSelected: { borderColor: colors.primary, borderWidth: 2 },
  optionTitle: {
    fontFamily: typography.headingSemibold,
    fontSize: 16,
    color: colors.text,
  },
  optionDetail: { ...textStyles.body, color: colors.textMuted, fontSize: 12 },
  toggle: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.outline,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  toggleActive: { backgroundColor: colors.successSoft },
  toggleText: { ...textStyles.label },
  error: { ...textStyles.body, color: colors.error },
});
