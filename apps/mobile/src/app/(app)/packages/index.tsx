import {
  useResponsiveStyles,
  useResponsiveTextStyles,
} from "@/theme/responsive";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { apiRequest } from "@/api/client";
import type { PackageListResponse } from "@/api/contracts";
import { mapApiPackage } from "@/api/mappers";
import { useAuth } from "@/auth/AuthProvider";
import { AppScreen } from "@/components/layout/AppScreen";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { listPackages, upsertPackage } from "@/db/repositories";
import type { RentalPackage } from "@/domain/types";
import { colors, spacing, textStyles, typography } from "@/theme/tokens";
import { formatRupiah } from "@/utils/format";
import { toUserFacingErrorMessage } from "@/utils/errors";

export default function PackagesScreen() {
  const responsive = useResponsiveStyles(styles);
  const responsiveText = useResponsiveTextStyles();
  const router = useRouter();
  const { session } = useAuth();
  const [packages, setPackages] = useState<RentalPackage[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    setError(null);
    setPackages(await listPackages(true, session));
    if (session && !session.token.startsWith("dev-only-")) {
      const remote = await apiRequest<PackageListResponse>(
        "/packages?limit=100",
        {
          token: session.token,
        },
      );
      const mapped = remote.map(mapApiPackage);
      await Promise.all(mapped.map((item) => upsertPackage(item, session)));
      setPackages(await listPackages(true, session));
    }
  }, [session]);

  useFocusEffect(
    useCallback(() => {
      void load().catch((reason) =>
        setError(
          toUserFacingErrorMessage(
            reason,
            "Daftar paket belum dapat diperbarui.",
          ),
        ),
      );
    }, [load]),
  );

  return (
    <AppScreen>
      <PageHeader
        back
        subtitle="Superadmin • online untuk perubahan"
        title="Paket & Harga"
      />
      {error ? (
        <Text accessibilityRole="alert" style={responsiveText.body}>
          {error}
        </Text>
      ) : null}
      <Button
        icon="tag-plus-outline"
        onPress={() => router.push("/packages/new")}
      >
        Tambah paket
      </Button>
      {packages.map((item) => (
        <Pressable
          key={item.id}
          onPress={() =>
            router.push({
              pathname: "/packages/[id]/edit",
              params: { id: item.id },
            })
          }
        >
          <Card style={responsive.package}>
            <View
              style={[
                responsive.accent,
                {
                  backgroundColor:
                    item.accent === "sunrise"
                      ? colors.sunrise
                      : item.accent === "standard"
                        ? colors.standard
                        : colors.primary,
                },
              ]}
            />
            <View style={responsive.copy}>
              <Text style={responsive.name}>{item.name}</Text>
              <Text style={responsive.description}>{item.description}</Text>
              <Text style={responsive.revision}>REVISI {item.revision}</Text>
            </View>
            <View style={responsive.right}>
              <Text style={responsive.price}>
                {formatRupiah(item.unitPrice)}
              </Text>
              <Text
                style={item.active ? responsive.active : responsive.inactive}
              >
                {item.active ? "AKTIF" : "NONAKTIF"}
              </Text>
            </View>
          </Card>
        </Pressable>
      ))}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  package: {
    paddingLeft: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    overflow: "hidden",
    gap: spacing.sm,
  },
  accent: { position: "absolute", left: 0, top: 0, bottom: 0, width: 5 },
  copy: { flex: 1 },
  name: {
    fontFamily: typography.headingSemibold,
    fontSize: 16,
    color: colors.text,
  },
  description: { ...textStyles.body, color: colors.textMuted, fontSize: 12 },
  revision: {
    ...textStyles.technical,
    fontSize: 9,
    marginTop: spacing.xs,
  },
  right: { alignItems: "flex-end" },
  price: {
    fontFamily: typography.heading,
    color: colors.primary,
    fontSize: 16,
  },
  active: { ...textStyles.label, color: colors.success, fontSize: 9 },
  inactive: { ...textStyles.label, color: colors.textMuted, fontSize: 9 },
});
