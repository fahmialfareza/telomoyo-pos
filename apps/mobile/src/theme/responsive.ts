import { useMemo } from "react";
import {
  useWindowDimensions,
  type ImageStyle,
  type TextStyle,
  type ViewStyle,
} from "react-native";

import { useTheme } from "./ThemeContext";
import type { Theme } from "./tokens";

export function getResponsiveSizing(width: number) {
  const compact = width < 414;
  return {
    compact,
    caption: 12,
    small: compact ? 13 : 14,
    body: compact ? 15 : 16,
    section: compact ? 19 : 20,
    subpage: compact ? 22 : 24,
    title: compact ? 26 : 28,
    gutter: compact ? 12 : 16,
    gap: compact ? 8 : 10,
    sectionGap: compact ? 16 : 20,
    maxContentWidth: 600,
  } as const;
}

type NativeStyle = ViewStyle | TextStyle | ImageStyle;
type StyleMap = Record<string, NativeStyle>;

/** Normalize existing semantic styles centrally, including their old local overrides.
 * Dimensions (QRs, icons, receipt paper, touch targets) are intentionally not scaled.
 */
export function responsiveStyles<T extends StyleMap>(
  base: T,
  width: number,
): T {
  const sizing = getResponsiveSizing(width);
  const space: Record<number, number> = {
    4: sizing.compact ? 4 : 6,
    8: sizing.gap,
    16: sizing.gutter,
    24: sizing.sectionGap,
    32: sizing.compact ? 24 : 32,
  };
  return Object.fromEntries(
    Object.entries(base).map(([name, original]) => {
      const next = { ...original } as Record<string, unknown>;
      for (const [property, value] of Object.entries(next)) {
        if (
          /^(padding|margin|gap|rowGap|columnGap)/.test(property) &&
          typeof value === "number"
        ) {
          next[property] =
            Math.sign(value) * (space[Math.abs(value)] ?? Math.abs(value));
        }
      }
      const originalSize = (original as TextStyle).fontSize;
      if (originalSize !== undefined && originalSize <= 36) {
        const size =
          originalSize <= 11
            ? sizing.caption
            : originalSize <= 13
              ? sizing.small
              : originalSize <= 16
                ? sizing.body
                : originalSize <= 18
                  ? sizing.section
                  : originalSize <= 23
                    ? sizing.subpage
                    : originalSize <= 28
                      ? sizing.title
                      : sizing.compact
                        ? 32
                        : 36;
        next.fontSize = size;
        next.lineHeight = Math.ceil(
          size *
            (originalSize <= 11
              ? 1.3
              : originalSize <= 13
                ? 1.4
                : originalSize <= 16
                  ? 1.5
                  : 1.25),
        );
      }
      return [name, next];
    }),
  ) as unknown as T;
}

const THEMED = Symbol("themed");

export interface ThemedStyles<T extends StyleMap> {
  readonly [THEMED]: (theme: Theme) => T;
}

/** Declares a stylesheet that depends on the active palette. The factory runs
 * once per color scheme; `useResponsiveStyles` resolves and scales it. */
export function themed<T extends StyleMap>(
  factory: (theme: Theme) => T,
): ThemedStyles<T> {
  const cache = new Map<Theme, T>();
  return {
    [THEMED]: (theme) => {
      let styles = cache.get(theme);
      if (!styles) {
        styles = factory(theme);
        cache.set(theme, styles);
      }
      return styles;
    },
  };
}

function isThemed<T extends StyleMap>(
  base: T | ThemedStyles<T>,
): base is ThemedStyles<T> {
  return typeof base === "object" && THEMED in base;
}

export function useResponsiveStyles<T extends StyleMap>(
  base: T | ThemedStyles<T>,
): T {
  const { width } = useWindowDimensions();
  const theme = useTheme();
  const compact = width < 414;
  const resolved = isThemed(base) ? base[THEMED](theme) : base;
  return useMemo(
    () => responsiveStyles(resolved, compact ? 360 : 414),
    [resolved, compact],
  );
}

/** Resolves a themed stylesheet for the active palette without responsive
 * scaling, for components that size things themselves. */
export function useThemedStyles<T extends StyleMap>(base: ThemedStyles<T>): T {
  return base[THEMED](useTheme());
}

export function useResponsiveTextStyles() {
  return useResponsiveStyles(useTheme().textStyles);
}

export function useResponsiveSizing() {
  const { width } = useWindowDimensions();
  return getResponsiveSizing(width);
}
