import { useResponsiveStyles } from "@/theme/responsive";
import { StyleSheet, View, type ViewProps, type ViewStyle } from "react-native";

import { cardStyle, spacing } from "@/theme/tokens";

interface CardProps extends ViewProps {
  padded?: boolean;
  style?: ViewStyle | ViewStyle[] | undefined;
}

export function Card({ padded = true, style, ...props }: CardProps) {
  const responsive = useResponsiveStyles(styles);
  return (
    <View
      style={[responsive.card, padded && responsive.padded, style]}
      {...props}
    />
  );
}

const styles = StyleSheet.create({
  card: cardStyle,
  padded: {
    padding: spacing.md,
  },
});
