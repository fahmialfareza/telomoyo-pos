import { useMemo } from "react";
import {
  useWindowDimensions,
  type ImageStyle,
  type TextStyle,
  type ViewStyle,
} from "react-native";

import { textStyles } from "./tokens";

export function getResponsiveSizing(width: number) {
  const compact = width < 414;
  return {
    compact,
    caption: compact ? 11 : 12,
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

export function useResponsiveStyles<T extends StyleMap>(base: T): T {
  const { width } = useWindowDimensions();
  const compact = width < 414;
  return useMemo(
    () => responsiveStyles(base, compact ? 360 : 414),
    [base, compact],
  );
}

export function useResponsiveTextStyles() {
  return useResponsiveStyles(textStyles);
}

export function useResponsiveSizing() {
  const { width } = useWindowDimensions();
  return getResponsiveSizing(width);
}
