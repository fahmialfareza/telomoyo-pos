import { useResponsiveStyles, themed } from "@/theme/responsive";
import { useThemeColors } from "@/theme/ThemeContext";
import { forwardRef, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputInstance,
  type TextInputProps,
} from "react-native";

import {
  minimumTouchTarget,
  radius,
  spacing,
  typography,
} from "@/theme/tokens";

import { Icon } from "./Icon";

interface FieldProps extends TextInputProps {
  label: string;
  error?: string | undefined;
  hint?: string;
}

export const Field = forwardRef<TextInputInstance, FieldProps>(function Field(
  { label, error, hint, secureTextEntry, style, onFocus, onBlur, ...props },
  ref,
) {
  const colors = useThemeColors();
  const responsive = useResponsiveStyles(styles);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [focused, setFocused] = useState(false);
  const isPasswordField = secureTextEntry === true;

  return (
    <View style={responsive.wrapper}>
      <Text style={responsive.label}>{label}</Text>
      <View>
        <TextInput
          ref={ref}
          accessibilityLabel={label}
          placeholderTextColor={colors.textMuted}
          selectionColor={colors.primary}
          onBlur={(event) => {
            setFocused(false);
            onBlur?.(event);
          }}
          onFocus={(event) => {
            setFocused(true);
            onFocus?.(event);
          }}
          style={[
            responsive.input,
            focused && responsive.inputFocused,
            error && responsive.inputError,
            style,
            isPasswordField && responsive.passwordInput,
          ]}
          {...props}
          secureTextEntry={isPasswordField ? !passwordVisible : secureTextEntry}
        />
        {isPasswordField ? (
          <Pressable
            accessibilityLabel={
              passwordVisible
                ? "Sembunyikan kata sandi"
                : "Tampilkan kata sandi"
            }
            accessibilityRole="button"
            onPress={() => setPasswordVisible((visible) => !visible)}
            style={({ pressed }) => [
              responsive.passwordToggle,
              pressed && responsive.passwordTogglePressed,
            ]}
          >
            <Icon
              color={colors.textMuted}
              name={passwordVisible ? "eye-off-outline" : "eye-outline"}
              size={22}
            />
          </Pressable>
        ) : null}
      </View>
      {error ? <Text style={responsive.error}>{error}</Text> : null}
      {!error && hint ? <Text style={responsive.hint}>{hint}</Text> : null}
    </View>
  );
});

const styles = themed(({ colors, textStyles }) =>
  StyleSheet.create({
    wrapper: {
      gap: spacing.xs,
    },
    label: textStyles.label,
    input: {
      minHeight: 56,
      borderWidth: 1.5,
      borderColor: "transparent",
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      backgroundColor: colors.container,
      color: colors.text,
      fontFamily: typography.body,
      fontSize: 16,
    },
    passwordInput: {
      paddingRight: minimumTouchTarget + spacing.sm,
    },
    passwordToggle: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      minWidth: minimumTouchTarget,
      alignItems: "center",
      justifyContent: "center",
    },
    passwordTogglePressed: {
      opacity: 0.6,
    },
    inputFocused: {
      borderColor: colors.primary,
      backgroundColor: colors.card,
    },
    inputError: {
      borderColor: colors.error,
    },
    error: {
      ...textStyles.body,
      color: colors.error,
      fontSize: 12,
    },
    hint: {
      ...textStyles.body,
      color: colors.textMuted,
      fontSize: 12,
    },
  }),
);
