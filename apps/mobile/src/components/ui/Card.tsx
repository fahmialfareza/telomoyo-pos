import { useResponsiveStyles, themed } from "@/theme/responsive";
import { StyleSheet, View, type ViewProps, type ViewStyle } from "react-native";

import { spacing } from "@/theme/tokens";

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

const styles = themed(({ cardStyle }) =>
  StyleSheet.create({
    card: cardStyle,
    padded: {
      padding: spacing.md,
    },
  }),
);
