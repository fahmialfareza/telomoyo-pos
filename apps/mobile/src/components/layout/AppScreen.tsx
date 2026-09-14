import { useResponsiveStyles, useResponsiveSizing } from "@/theme/responsive";
import { useRouter, useSegments } from "expo-router";
import { useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  ScrollView,
  useWindowDimensions,
  type ViewStyle,
} from "react-native";
import {
  KeyboardAvoidingView,
  KeyboardAwareScrollView,
  KeyboardStickyView,
  type KeyboardAwareScrollViewProps,
} from "react-native-keyboard-controller";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";

import { useAuthStore } from "@/auth/auth-store";
import { useModeStore } from "@/mode/mode-store";
import {
  colors,
  minimumTouchTarget,
  spacing,
  typography,
} from "@/theme/tokens";

import { SyncBar } from "./SyncBar";

interface AppScreenProps {
  children?: React.ReactNode;
  authenticated?: boolean;
  scroll?: boolean;
  stickyFooter?: React.ReactNode;
  contentStyle?: ViewStyle;
  scrollProps?: KeyboardAwareScrollViewProps;
}

export function AppScreen({
  children,
  authenticated = true,
  scroll = true,
  stickyFooter,
  contentStyle,
  scrollProps,
}: AppScreenProps) {
  const responsive = useResponsiveStyles(styles);
  const router = useRouter();
  const segments = useSegments();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const sizing = useResponsiveSizing();
  const [footerHeight, setFooterHeight] = useState(0);
  const bottomInset = (segments as string[]).includes("(tabs)")
    ? 0
    : insets.bottom;
  const sandbox = useModeStore((state) => state.dataMode === "sandbox");
  const tenant = useAuthStore((state) => state.session?.tenant);
  const tenantContext = useAuthStore((state) =>
    Boolean(
      state.session &&
      (!state.session.contextKind || state.session.contextKind === "tenant"),
    ),
  );
  const notice = useAuthStore((state) => state.notice);
  const dismissNotice = useAuthStore((state) => state.dismissNotice);
  const bottomOffset =
    scrollProps?.bottomOffset ??
    (stickyFooter ? footerHeight + sizing.gutter : sizing.gutter);
  const content = scroll ? (
    <KeyboardAwareScrollView
      {...scrollProps}
      testID="app-screen-scroll"
      bottomOffset={bottomOffset}
      contentContainerStyle={[
        responsive.content,
        { gap: sizing.sectionGap },
        !stickyFooter && { paddingBottom: sizing.sectionGap + bottomInset },
        contentStyle,
        scrollProps?.contentContainerStyle,
      ]}
      keyboardShouldPersistTaps={
        scrollProps?.keyboardShouldPersistTaps ?? "handled"
      }
      showsVerticalScrollIndicator={
        scrollProps?.showsVerticalScrollIndicator ?? false
      }
      style={[responsive.flex, scrollProps?.style]}
    >
      {children}
    </KeyboardAwareScrollView>
  ) : (
    <KeyboardAvoidingView
      automaticOffset
      behavior="padding"
      style={responsive.flex}
    >
      <View style={[responsive.content, responsive.flex, contentStyle]}>
        {children}
      </View>
    </KeyboardAvoidingView>
  );

  return (
    <SafeAreaView edges={["top"]} style={responsive.safe}>
      {authenticated && tenantContext ? <SyncBar /> : null}
      {authenticated && tenantContext && tenant ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Ganti bisnis. Bisnis aktif: ${tenant.name}`}
          onPress={() => router.push("/contexts")}
          style={[responsive.tenantBanner, { minHeight: minimumTouchTarget }]}
        >
          <Text style={responsive.tenantName}>
            {tenant.name} · Ganti bisnis
          </Text>
        </Pressable>
      ) : null}
      {authenticated && sandbox ? (
        <View accessibilityRole="alert" style={responsive.sandboxBanner}>
          <Text style={responsive.sandboxBannerText}>
            MODE UJI — DATA TIDAK MASUK LAPORAN PRODUKSI
          </Text>
        </View>
      ) : null}
      {authenticated && notice ? (
        <View accessibilityRole="alert" style={responsive.recoveryNotice}>
          <Text style={responsive.recoveryNoticeText}>{notice}</Text>
          <Pressable
            accessibilityLabel="Tutup pemberitahuan"
            accessibilityRole="button"
            hitSlop={spacing.sm}
            style={responsive.dismissTarget}
            onPress={() => void dismissNotice().catch(() => undefined)}
          >
            <Text style={responsive.recoveryNoticeDismiss}>Tutup</Text>
          </Pressable>
        </View>
      ) : null}
      {content}
      {stickyFooter ? (
        <KeyboardStickyView>
          <View
            testID="app-screen-sticky-footer"
            onLayout={(event) =>
              setFooterHeight(event.nativeEvent.layout.height)
            }
            style={responsive.footer}
          >
            <ScrollView
              testID="app-screen-footer-scroll"
              nestedScrollEnabled
              keyboardShouldPersistTaps="handled"
              style={{
                flexGrow: 0,
                maxHeight: Math.max(
                  96,
                  (height - insets.top - insets.bottom) * 0.45,
                ),
              }}
              contentContainerStyle={[
                responsive.footerContent,
                {
                  padding: sizing.gutter,
                  paddingBottom: sizing.gutter + bottomInset,
                },
              ]}
            >
              {stickyFooter}
            </ScrollView>
          </View>
        </KeyboardStickyView>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.surface,
  },
  tenantBanner: {
    backgroundColor: colors.primarySoft,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  tenantName: {
    fontFamily: typography.bodySemibold,
    color: colors.primary,
    fontSize: 12,
  },
  flex: { flex: 1 },
  content: {
    width: "100%",
    maxWidth: 600,
    alignSelf: "center",
    padding: spacing.md,
    paddingBottom: spacing.xl,
    gap: spacing.md,
  },
  footer: {
    borderTopWidth: 1,
    borderTopColor: colors.outline,
    backgroundColor: colors.card,
  },
  footerContent: {
    width: "100%",
    maxWidth: 600,
    alignSelf: "center",
  },
  dismissTarget: {
    minHeight: minimumTouchTarget,
    minWidth: minimumTouchTarget,
    alignItems: "center",
    justifyContent: "center",
  },
  sandboxBanner: {
    minHeight: 34,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.warningSoft,
    borderBottomWidth: 1,
    borderBottomColor: colors.warning,
  },
  sandboxBannerText: {
    color: colors.warning,
    fontFamily: typography.bodySemibold,
    fontSize: 11,
    textAlign: "center",
  },
  recoveryNotice: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.primarySoft,
    borderBottomWidth: 1,
    borderBottomColor: colors.primary,
  },
  recoveryNoticeText: {
    flex: 1,
    color: colors.text,
    fontFamily: typography.body,
    fontSize: 12,
  },
  recoveryNoticeDismiss: {
    color: colors.primary,
    fontFamily: typography.bodySemibold,
    fontSize: 12,
  },
});
