import { ScrollView, StyleSheet, Text } from "react-native";

import { Card } from "@/components/ui/Card";
import { formatReceipt } from "@/printer/receipt";
import type { ReceiptDocument } from "@/printer/types";
import { colors, spacing, textStyles, typography } from "@/theme/tokens";
import {
  useResponsiveStyles,
  useResponsiveTextStyles,
} from "@/theme/responsive";

interface ReceiptPreviewProps {
  document: ReceiptDocument;
  columns: 32 | 48;
}

/** Read-only: this component never connects a printer or records an attempt. */
export function ReceiptPreview({ document, columns }: ReceiptPreviewProps) {
  const responsive = useResponsiveStyles(styles);
  const headings = useResponsiveTextStyles();
  return (
    <Card style={responsive.card} testID="receipt-preview">
      <Text style={headings.heading}>Pratinjau struk</Text>
      <Text style={responsive.caption}>
        {`${columns === 32 ? "58 mm • 32 kolom" : "80 mm • 48 kolom"} · Pratinjau tidak mencetak atau mengubah status cetak.`}
      </Text>
      <ScrollView
        nestedScrollEnabled
        style={styles.viewport}
        accessibilityLabel="Gulir pratinjau struk"
      >
        <ScrollView
          horizontal
          contentContainerStyle={styles.paper}
          accessibilityLabel="Geser lebar struk"
        >
          <Text selectable style={styles.receipt} testID="receipt-preview-text">
            {formatReceipt(document, columns)}
          </Text>
        </ScrollView>
      </ScrollView>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing.sm },
  caption: { ...textStyles.body, color: colors.textMuted },
  viewport: { maxHeight: 360 },
  paper: { padding: spacing.sm },
  receipt: {
    fontFamily: typography.mono,
    fontSize: 12,
    lineHeight: 18,
    letterSpacing: 0,
    color: colors.text,
    flexShrink: 0,
  },
});
