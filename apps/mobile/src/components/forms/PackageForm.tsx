import { useResponsiveStyles } from "@/theme/responsive";
import { useState } from "react";
import { StyleSheet, Text } from "react-native";

import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import type { RentalPackage } from "@/domain/types";
import { colors, spacing, textStyles } from "@/theme/tokens";

export interface PackageFormValue {
  name: string;
  description: string;
  unitPrice: number;
  active: boolean;
}

export function PackageForm({
  initial,
  create,
  onSubmit,
}: {
  initial?: RentalPackage;
  create: boolean;
  onSubmit: (value: PackageFormValue) => Promise<void>;
}) {
  const responsive = useResponsiveStyles(styles);
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [price, setPrice] = useState(initial ? String(initial.unitPrice) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const unitPrice = Number(price);
    if (!name.trim() || !Number.isInteger(unitPrice) || unitPrice <= 0) {
      setError("Nama dan harga rupiah bulat lebih dari nol wajib diisi.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        description: description.trim(),
        unitPrice,
        active: initial?.active ?? true,
      });
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Paket gagal disimpan.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Field label="Nama paket" onChangeText={setName} value={name} />
      <Field
        label="Deskripsi"
        multiline
        numberOfLines={3}
        onChangeText={setDescription}
        style={responsive.description}
        value={description}
      />
      <Field
        keyboardType="number-pad"
        label="Harga (IDR)"
        onChangeText={(value) => setPrice(value.replace(/\D/g, ""))}
        value={price}
      />
      <Text style={responsive.note}>
        Perubahan harga membuat revisi baru dan hanya berlaku untuk baris
        transaksi yang dibuat setelahnya.
      </Text>
      {error ? <Text style={responsive.error}>{error}</Text> : null}
      <Button
        icon="content-save-outline"
        loading={saving}
        onPress={() => void submit()}
      >
        {create ? "Tambah paket" : "Simpan revisi paket"}
      </Button>
    </>
  );
}

const styles = StyleSheet.create({
  description: {
    minHeight: 96,
    textAlignVertical: "top",
    paddingTop: spacing.md,
  },
  note: { ...textStyles.body, color: colors.textMuted },
  error: { ...textStyles.body, color: colors.error },
});
