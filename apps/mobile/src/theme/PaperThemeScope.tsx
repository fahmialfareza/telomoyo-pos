import { useContext, useMemo, type ReactNode } from "react";

import { ThemeContext } from "./ThemeContext";
import { lightTheme } from "./tokens";

/** Forces the light palette for "paper" surfaces such as receipt previews,
 * which must look like what the thermal printer produces in either scheme. */
export function PaperThemeScope({ children }: { children: ReactNode }) {
  const parent = useContext(ThemeContext);
  const value = useMemo(() => ({ ...parent, theme: lightTheme }), [parent]);
  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}
