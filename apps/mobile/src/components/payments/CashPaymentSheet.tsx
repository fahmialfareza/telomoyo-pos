import { useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ActionGroup } from "@/components/ui/ActionGroup";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { cashChange, suggestCashAmounts } from "@/domain/payments";
import { themed, useResponsiveStyles } from "@/theme/responsive";
import { radius, spacing, typography } from "@/theme/tokens";
import { formatRupiah } from "@/utils/format";

interface CashPaymentSheetProps {
  visible: boolean;
  total: number;
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (cashReceived: number) => void;
}

/** Collects the cash handed over and shows the change before saving. The
 * amount is only used for the printed receipt; it is not stored or synced. */
export function CashPaymentSheet(props: CashPaymentSheetProps) {
  return (
    <Modal
      animationType="fade"
      onRequestClose={() => {
        if (!props.saving) props.onCancel();
      }}
      statusBarTranslucent
      transparent
      visible={props.visible}
    >
      {/* Mounted only while visible, so each sale starts with an empty field. */}
      {props.visible ? <CashPaymentForm {...props} /> : null}
    </Modal>
  );
}

function CashPaymentForm({
  total,
  saving,
  error,
  onCancel,
  onConfirm,
}: CashPaymentSheetProps) {
  const responsive = useResponsiveStyles(styles);
  const insets = useSafeAreaInsets();
  const [input, setInput] = useState("");

  const received = Number(input) || 0;
  const change = cashChange(total, received);
  const [exact, ...rounded] = suggestCashAmounts(total);

  return (
    <KeyboardAvoidingView behavior="padding" style={responsive.overlay}>
      <Pressable
        accessibilityLabel="Tutup pembayaran tunai"
        accessibilityRole="button"
        disabled={saving}
        onPress={onCancel}
        style={StyleSheet.absoluteFill}
      />
      <View
        accessibilityViewIsModal
        style={[
          responsive.sheet,
          { paddingBottom: insets.bottom + spacing.md },
        ]}
      >
        <View style={responsive.header}>
          <Text accessibilityRole="header" style={responsive.title}>
            Pembayaran tunai
          </Text>
          <Text style={responsive.total}>{formatRupiah(total)}</Text>
        </View>

        {exact !== undefined ? (
          <View style={responsive.quickAmounts}>
            <Button
              disabled={saving}
              icon="cash-check"
              onPress={() => onConfirm(exact)}
              variant="secondary"
            >
              Uang pas
            </Button>
            {rounded.map((amount) => (
              <Button
                compact
                disabled={saving}
                key={amount}
                onPress={() => setInput(String(amount))}
                variant="secondary"
              >
                {formatRupiah(amount)}
              </Button>
            ))}
          </View>
        ) : null}

        <Field
          editable={!saving}
          hint="Ketik nominal atau pilih jumlah cepat di atas."
          inputMode="numeric"
          keyboardType="number-pad"
          label="Uang diterima"
          onChangeText={(value) => setInput(value.replace(/\D/g, ""))}
          placeholder="0"
          value={input}
        />

        <View accessibilityLiveRegion="polite" style={responsive.changeRow}>
          <Text style={responsive.changeLabel}>
            {change === null && received > 0 ? "Kurang" : "Kembalian"}
          </Text>
          <Text
            style={[
              responsive.changeValue,
              change === null && received > 0 && responsive.shortValue,
            ]}
          >
            {formatRupiah(change ?? (received > 0 ? total - received : 0))}
          </Text>
        </View>

        {error ? (
          <Text accessibilityRole="alert" style={responsive.error}>
            {error}
          </Text>
        ) : null}

        <ActionGroup horizontal>
          <Button disabled={saving} onPress={onCancel} variant="ghost">
            Batal
          </Button>
          <Button
            disabled={change === null}
            icon="printer-outline"
            loading={saving}
            onPress={() => onConfirm(received)}
          >
            Simpan & cetak
          </Button>
        </ActionGroup>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = themed(({ colors, textStyles }) =>
  StyleSheet.create({
    overlay: {
      flex: 1,
      justifyContent: "flex-end",
      backgroundColor: "rgba(0,0,0,0.5)",
    },
    sheet: {
      backgroundColor: colors.card,
      borderTopLeftRadius: radius.xl,
      borderTopRightRadius: radius.xl,
      paddingHorizontal: spacing.md,
      paddingTop: spacing.md,
      gap: spacing.md,
    },
    header: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "baseline",
      justifyContent: "space-between",
      gap: spacing.sm,
    },
    title: { ...textStyles.heading },
    total: {
      fontFamily: typography.price,
      fontSize: 22,
      color: colors.primary,
    },
    quickAmounts: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: spacing.sm,
    },
    changeRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      borderRadius: radius.md,
      backgroundColor: colors.successSoft,
    },
    changeLabel: {
      ...textStyles.body,
      fontFamily: typography.bodySemibold,
    },
    changeValue: {
      fontFamily: typography.heading,
      fontSize: 20,
      color: colors.success,
    },
    shortValue: { color: colors.error },
    error: { ...textStyles.body, color: colors.error },
  }),
);
