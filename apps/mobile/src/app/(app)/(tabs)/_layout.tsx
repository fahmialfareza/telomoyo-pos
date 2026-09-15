import { Tabs } from "expo-router";

import { useAuth } from "@/auth/AuthProvider";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useWindowDimensions } from "react-native";
import { useResponsiveSizing } from "@/theme/responsive";
import { Icon, type IconName } from "@/components/ui/Icon";
import { colors, minimumTouchTarget, typography } from "@/theme/tokens";

const tabs: {
  name: string;
  title: string;
  icon: IconName;
}[] = [
  { name: "home", title: "Beranda", icon: "view-dashboard-outline" },
  { name: "sell", title: "Transaksi", icon: "receipt-text-plus-outline" },
  { name: "history", title: "Riwayat", icon: "history" },
  { name: "users", title: "Pengguna", icon: "account-group-outline" },
  { name: "settings", title: "Pengaturan", icon: "cog-outline" },
];

export default function TabsLayout() {
  const { session } = useAuth();
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const sizing = useResponsiveSizing();

  return (
    <Tabs
      key={session?.sessionId}
      initialRouteName={session?.contextKind === "account" ? "users" : "home"}
      screenOptions={{
        headerShown: false,
        lazy: true,
        tabBarHideOnKeyboard: true,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: {
          fontFamily: typography.bodyMedium,
          fontSize: sizing.caption,
          lineHeight: Math.ceil(sizing.caption * 1.3),
        },
        tabBarStyle: {
          height: 56 + insets.bottom + Math.max(0, fontScale - 1) * 16,
          paddingTop: 6,
          paddingBottom: Math.max(6, insets.bottom),
          borderTopColor: colors.outline,
          backgroundColor: colors.card,
        },
        tabBarItemStyle: {
          minHeight: minimumTouchTarget,
        },
      }}
    >
      {tabs.map((tab) => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          options={{
            title: tab.title,
            ...(tab.name === "users" && session?.user.role !== "superadmin"
              ? { href: null }
              : {}),
            tabBarIcon: ({ color, focused }) => (
              <Icon
                color={String(color)}
                name={
                  focused
                    ? (tab.icon.replace("-outline", "") as IconName)
                    : tab.icon
                }
                size={24}
              />
            ),
          }}
        />
      ))}
    </Tabs>
  );
}
