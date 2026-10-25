import { createContext, useContext } from "react";

import { lightTheme, type ColorScheme, type Theme } from "./tokens";

export type AppearancePreference = "system" | "light" | "dark";

export interface ThemeContextValue {
  theme: Theme;
  preference: AppearancePreference;
  setPreference: (preference: AppearancePreference) => void;
}

// Components rendered outside the provider (tests, isolated previews) get the
// light theme, matching the app's historical look.
export const ThemeContext = createContext<ThemeContextValue>({
  theme: lightTheme,
  preference: "system",
  setPreference: () => undefined,
});

export function resolveColorScheme(
  preference: AppearancePreference,
  system: ColorScheme | null | undefined,
): ColorScheme {
  if (preference !== "system") return preference;
  return system === "dark" ? "dark" : "light";
}

export function useTheme(): Theme {
  return useContext(ThemeContext).theme;
}

export function useThemeColors() {
  return useContext(ThemeContext).theme.colors;
}

export function useAppearancePreference() {
  const { preference, setPreference } = useContext(ThemeContext);
  return { preference, setPreference };
}
