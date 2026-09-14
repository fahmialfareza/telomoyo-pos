import {
  useResponsiveStyles,
  useResponsiveTextStyles,
} from "@/theme/responsive";
import { StyleSheet, Text, View } from "react-native";

import { colors, spacing, textStyles } from "@/theme/tokens";

import { Button } from "./Button";
import { Icon, type IconName } from "./Icon";

interface StateViewProps {
  icon?: IconName;
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function StateView({
  icon = "inbox-outline",
  title,
  message,
  actionLabel,
  onAction,
}: StateViewProps) {
  const responsive = useResponsiveStyles(styles);
  const responsiveText = useResponsiveTextStyles();
  return (
    <View style={responsive.wrapper}>
      <Icon color={colors.textMuted} name={icon} size={36} />
      <Text style={responsiveText.heading}>{title}</Text>
      <Text style={responsive.message}>{message}</Text>
      {actionLabel && onAction ? (
        <Button compact onPress={onAction} variant="secondary">
          {actionLabel}
        </Button>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.md,
    alignItems: "center",
    gap: spacing.sm,
  },
  message: {
    ...textStyles.body,
    color: colors.textMuted,
    textAlign: "center",
    maxWidth: 320,
  },
});
