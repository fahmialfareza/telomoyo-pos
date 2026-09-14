import {
  useResponsiveStyles,
  useResponsiveTextStyles,
} from "@/theme/responsive";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";

import { colors, spacing, textStyles } from "@/theme/tokens";

import { Icon } from "../ui/Icon";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  back?: boolean;
  right?: React.ReactNode;
}

export function PageHeader({
  title,
  subtitle,
  back = false,
  right,
}: PageHeaderProps) {
  const responsive = useResponsiveStyles(styles);
  const responsiveText = useResponsiveTextStyles();
  const router = useRouter();

  return (
    <View style={responsive.row}>
      {back ? (
        <Pressable
          accessibilityLabel="Kembali"
          accessibilityRole="button"
          onPress={() => router.back()}
          style={responsive.back}
        >
          <Icon color={colors.primary} name="arrow-left" />
        </Pressable>
      ) : null}
      <View style={responsive.copy}>
        <Text
          accessibilityRole="header"
          style={back ? responsiveText.subpage : responsiveText.title}
        >
          {title}
        </Text>
        {subtitle ? <Text style={responsive.subtitle}>{subtitle}</Text> : null}
      </View>
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  back: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: -10,
  },
  copy: {
    flex: 1,
  },
  subtitle: {
    ...textStyles.body,
    color: colors.textMuted,
    marginTop: 2,
  },
});
