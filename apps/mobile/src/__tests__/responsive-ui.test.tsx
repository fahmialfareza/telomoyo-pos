import { fireEvent, render } from "@testing-library/react-native";
import { StyleSheet, Text, View } from "react-native";

import { ActionGroup } from "@/components/ui/ActionGroup";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import {
  getResponsiveSizing,
  responsiveStyles,
  useResponsiveTextStyles,
} from "@/theme/responsive";
import { colors, textStyles } from "@/theme/tokens";

let mockDimensions = { width: 360, height: 640, scale: 1, fontScale: 1 };
jest.mock("@/components/ui/Icon", () => ({ Icon: () => null }));
jest.mock("react-native/Libraries/Utilities/useWindowDimensions", () => ({
  __esModule: true,
  default: () => mockDimensions,
}));

function Typography() {
  const styles = useResponsiveTextStyles();
  return (
    <Text testID="body" style={styles.body}>
      Contoh
    </Text>
  );
}

describe("responsive UI sizing", () => {
  beforeEach(() => {
    mockDimensions = { width: 360, height: 640, scale: 1, fontScale: 1 };
  });

  it.each([320, 360, 390, 414, 768])(
    "uses the agreed scale at %i dp",
    (width) => {
      const compact = width < 414;
      const sizing = getResponsiveSizing(width);
      expect(sizing.body).toBe(compact ? 15 : 16);
      expect(sizing.small).toBe(compact ? 13 : 14);
      expect(sizing.title).toBe(compact ? 26 : 28);
      expect(sizing.gutter).toBe(compact ? 12 : 16);
      const styles = responsiveStyles(textStyles, width);
      expect(styles.body.lineHeight).toBeGreaterThan(styles.body.fontSize);
      expect(styles.body.fontFamily).toBe(textStyles.body.fontFamily);
    },
  );

  it("responds to window changes without remounting or disabling font scaling", () => {
    const screen = render(<Typography />);
    expect(
      StyleSheet.flatten(screen.getByTestId("body").props.style).fontSize,
    ).toBe(15);
    mockDimensions = { ...mockDimensions, width: 768, fontScale: 1.5 };
    screen.rerender(<Typography />);
    expect(
      StyleSheet.flatten(screen.getByTestId("body").props.style).fontSize,
    ).toBe(16);
    expect(screen.getByTestId("body").props.allowFontScaling).not.toBe(false);
  });

  it("keeps readable text and dimensions independent", () => {
    const base = {
      input: { minHeight: 56, fontSize: 16, lineHeight: 9, padding: 16 },
      icon: { width: 48, height: 48 },
      glyph: { fontSize: 54 },
    };
    const result = responsiveStyles(base, 320);
    expect(result.input).toMatchObject({
      minHeight: 56,
      fontSize: 15,
      lineHeight: 23,
      padding: 12,
    });
    expect(result.icon).toEqual(base.icon);
    expect(result.glyph).toEqual(base.glyph);
    expect(base.input.lineHeight).toBe(9);
  });

  it("uses red outlined cancellation and red filled destructive confirmation", () => {
    const screen = render(
      <View>
        <Button variant="danger">Batal</Button>
        <Button variant="dangerSolid">Hapus</Button>
      </View>,
    );
    expect(
      StyleSheet.flatten(
        screen.getByRole("button", { name: "Batal" }).props.style,
      ),
    ).toMatchObject({
      minHeight: 48,
      borderColor: colors.error,
      backgroundColor: colors.card,
    });
    expect(
      StyleSheet.flatten(screen.getByText("Batal").props.style).color,
    ).toBe(colors.error);
    expect(
      StyleSheet.flatten(
        screen.getByRole("button", { name: "Hapus" }).props.style,
      ).backgroundColor,
    ).toBe(colors.error);
  });

  it("keeps inputs at 56 dp and preserves password visibility controls", () => {
    const screen = render(<Field label="Kata sandi" secureTextEntry />);
    const input = screen.getByLabelText("Kata sandi");
    expect(StyleSheet.flatten(input.props.style).minHeight).toBe(56);
    expect(input.props.secureTextEntry).toBe(true);
    fireEvent.press(
      screen.getByRole("button", { name: "Tampilkan kata sandi" }),
    );
    expect(input.props.secureTextEntry).toBe(false);
  });

  it.each([1.2, 1.5])(
    "stacks adjacent actions at font scale %s",
    (fontScale) => {
      mockDimensions = { ...mockDimensions, fontScale };
      const screen = render(
        <ActionGroup horizontal>
          <Button>A</Button>
          <Button>B</Button>
        </ActionGroup>,
      );
      const group = screen.UNSAFE_getAllByType(View)[0]!;
      expect(StyleSheet.flatten(group.props.style).flexDirection).toBe(
        "column",
      );
    },
  );
});
