import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useColorScheme } from "react-native";

import {
  readAppearancePreference,
  writeAppearancePreference,
} from "@/security/secure-store";

import {
  ThemeContext,
  resolveColorScheme,
  type AppearancePreference,
} from "./ThemeContext";
import { darkTheme, lightTheme } from "./tokens";

export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme();
  const [preference, setPreferenceState] =
    useState<AppearancePreference>("system");

  useEffect(() => {
    let active = true;
    void readAppearancePreference()
      .then((stored) => {
        if (active) setPreferenceState(stored);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const setPreference = useCallback((next: AppearancePreference) => {
    setPreferenceState(next);
    void writeAppearancePreference(next).catch(() => undefined);
  }, []);

  const scheme = resolveColorScheme(preference, system);
  const value = useMemo(
    () => ({
      theme: scheme === "dark" ? darkTheme : lightTheme,
      preference,
      setPreference,
    }),
    [preference, scheme, setPreference],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}
