import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import { useEffect, useMemo, type ReactNode } from "react";

import { useTheme } from "./ThemeContext";

/** Applies the active palette to navigation containers, the status bar and the
 * native root view so transitions never flash the opposite scheme. */
export function NavigationTheme({ children }: { children: ReactNode }) {
  const { scheme, colors } = useTheme();
  const navigationTheme = useMemo(() => {
    const base = scheme === "dark" ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        primary: colors.primary,
        background: colors.surface,
        card: colors.card,
        text: colors.text,
        border: colors.outline,
      },
    };
  }, [colors, scheme]);

  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(colors.surface).catch(
      () => undefined,
    );
  }, [colors.surface]);

  return (
    <ThemeProvider value={navigationTheme}>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      {children}
    </ThemeProvider>
  );
}
