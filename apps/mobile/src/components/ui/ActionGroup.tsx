import { Children, type ReactNode } from "react";
import {
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { useResponsiveSizing } from "@/theme/responsive";

export function ActionGroup({
  children,
  horizontal = false,
  style,
}: {
  children: ReactNode;
  horizontal?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { width, fontScale } = useWindowDimensions();
  const { gap } = useResponsiveSizing();
  const row = horizontal && width >= 360 && fontScale < 1.2;
  return (
    <View style={[{ gap, flexDirection: row ? "row" : "column" }, style]}>
      {Children.toArray(children).map((child, index) => (
        <View key={index} style={row ? { flex: 1, minWidth: 0 } : undefined}>
          {child}
        </View>
      ))}
    </View>
  );
}
