import {
  useResponsiveStyles,
  useResponsiveTextStyles,
} from "@/theme/responsive";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StyleSheet, Text } from "react-native";

import { useAuth } from "@/auth/AuthProvider";
import { AppScreen } from "@/components/layout/AppScreen";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { colors, spacing, textStyles } from "@/theme/tokens";
import { displayTransactionId } from "@/utils/format";

export default function PrintFailureScreen() {
  const responsive = useResponsiveStyles(styles);
  const responsiveText = useResponsiveTextStyles();
  const { id, status, message } = useLocalSearchParams<{
    id: string;
    status?: string;
    message?: string;
  }>();
  const router = useRouter();
  const { session } = useAuth();
  const uncertain = status === "unknown";

  return (
    <AppScreen>
      <PageHeader back title="Masalah pencetakan" />
      <Text style={[responsive.symbol, uncertain && { color: colors.warning }]}>
        {uncertain ? "?" : "!"}
      </Text>
      <Text style={responsive.title}>
        {uncertain
          ? "Hasil cetak tidak dapat dipastikan"
          : "Struk gagal dicetak"}
      </Text>
      <Text style={responsive.subtitle}>
        Penjualan {displayTransactionId(id, session?.dataMode ?? "production")}{" "}
        tetap tersimpan. Kegagalan printer tidak pernah membatalkan transaksi.
      </Text>
      <Card style={responsive.card}>
        <Text style={responsiveText.label}>DETAIL PRINTER</Text>
        <Text style={responsive.message}>
          {message ?? "Tidak ada detail tambahan."}
        </Text>
        {uncertain ? (
          <Text style={responsive.warning}>
            Periksa kertas terlebih dahulu. Sistem tidak mencoba ulang otomatis
            agar struk tidak tercetak ganda.
          </Text>
        ) : null}
      </Card>
      <Button
        icon="printer-outline"
        onPress={() =>
          router.replace({
            pathname: "/transactions/[id]/print",
            params: { id },
          })
        }
      >
        {uncertain ? "Cetak salinan secara manual" : "Coba cetak lagi"}
      </Button>
      <Button
        onPress={() => router.replace("/(app)/(tabs)/history")}
        variant="secondary"
      >
        Kembali ke riwayat
      </Button>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  symbol: {
    ...textStyles.title,
    color: colors.error,
    fontSize: 54,
    textAlign: "center",
  },
  title: { ...textStyles.title, textAlign: "center" },
  subtitle: {
    ...textStyles.body,
    color: colors.textMuted,
    textAlign: "center",
  },
  card: { gap: spacing.sm },
  message: { ...textStyles.body },
  warning: { ...textStyles.body, color: colors.warning },
});
