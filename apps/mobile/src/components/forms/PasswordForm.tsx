import { useResponsiveStyles } from "@/theme/responsive";
import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import { StyleSheet, Text } from "react-native";
import { z } from "zod";

import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { colors, spacing, textStyles } from "@/theme/tokens";

const schema = z
  .object({
    currentPassword: z.string().min(1, "Kata sandi saat ini wajib diisi."),
    newPassword: z
      .string()
      .min(12, "Kata sandi baru minimal 12 karakter.")
      .max(256),
    confirmation: z.string(),
  })
  .refine((value) => value.newPassword === value.confirmation, {
    path: ["confirmation"],
    message: "Konfirmasi kata sandi tidak sama.",
  });

type FormData = z.infer<typeof schema>;

export function PasswordForm({
  onSubmit,
  submitLabel = "Simpan kata sandi",
}: {
  onSubmit: (currentPassword: string, newPassword: string) => Promise<void>;
  submitLabel?: string;
}) {
  const responsive = useResponsiveStyles(styles);
  const {
    control,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting, isSubmitSuccessful },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      currentPassword: "",
      newPassword: "",
      confirmation: "",
    },
  });

  const submit = handleSubmit(async (values) => {
    try {
      await onSubmit(values.currentPassword, values.newPassword);
      reset();
    } catch (error) {
      setError("root", {
        message:
          error instanceof Error
            ? error.message
            : "Kata sandi tidak dapat disimpan.",
      });
    }
  });

  return (
    <>
      <Text style={responsive.help}>
        Gunakan 12–256 karakter. Mengubah kata sandi akan mencabut sesi lain.
      </Text>
      <Controller
        control={control}
        name="currentPassword"
        render={({ field }) => (
          <Field
            error={errors.currentPassword?.message}
            label="Kata sandi saat ini"
            onBlur={field.onBlur}
            onChangeText={field.onChange}
            secureTextEntry
            value={field.value}
          />
        )}
      />
      <Controller
        control={control}
        name="newPassword"
        render={({ field }) => (
          <Field
            error={errors.newPassword?.message}
            label="Kata sandi baru"
            onBlur={field.onBlur}
            onChangeText={field.onChange}
            secureTextEntry
            value={field.value}
          />
        )}
      />
      <Controller
        control={control}
        name="confirmation"
        render={({ field }) => (
          <Field
            error={errors.confirmation?.message}
            label="Ulangi kata sandi baru"
            onBlur={field.onBlur}
            onChangeText={field.onChange}
            secureTextEntry
            value={field.value}
          />
        )}
      />
      {errors.root?.message ? (
        <Text style={responsive.error}>{errors.root.message}</Text>
      ) : null}
      {isSubmitSuccessful ? (
        <Text style={responsive.success}>Kata sandi berhasil diperbarui.</Text>
      ) : null}
      <Button
        icon="lock-check-outline"
        loading={isSubmitting}
        onPress={() => void submit()}
      >
        {submitLabel}
      </Button>
    </>
  );
}

const styles = StyleSheet.create({
  help: { ...textStyles.body, color: colors.textMuted },
  error: { ...textStyles.body, color: colors.error },
  success: { ...textStyles.body, color: colors.success },
  spacer: { marginBottom: spacing.xs },
});
