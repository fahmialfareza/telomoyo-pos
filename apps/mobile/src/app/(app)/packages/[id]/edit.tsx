import { useResponsiveStyles } from "@/theme/responsive";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet } from "react-native";

import { apiRequest } from "@/api/client";
import { useAuth } from "@/auth/AuthProvider";
import {
  PackageForm,
  type PackageFormValue,
} from "@/components/forms/PackageForm";
import { AppScreen } from "@/components/layout/AppScreen";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { listPackages } from "@/db/repositories";
import type { RentalPackage } from "@/domain/types";
import { spacing } from "@/theme/tokens";

export default function EditPackageScreen() {
  const responsive = useResponsiveStyles(styles);
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const [item, setItem] = useState<RentalPackage | null>(null);

  useEffect(() => {
    if (!session) return;
    let active = true;
    void listPackages(true, session).then((values) => {
      if (active) setItem(values.find((value) => value.id === id) ?? null);
    });
    return () => {
      active = false;
    };
  }, [id, session]);

  const save = async (value: PackageFormValue) => {
    if (!session || !item) return;
    await apiRequest(`/packages/${item.id}`, {
      method: "PATCH",
      token: session.token,
      body: { ...value, baseRevision: item.revision },
    });
    router.back();
  };

  return (
    <AppScreen>
      <PageHeader
        back
        {...(item ? { subtitle: `Revisi ${item.revision}` } : {})}
        title="Edit Paket"
      />
      {item ? (
        <Card style={responsive.form}>
          <PackageForm create={false} initial={item} onSubmit={save} />
        </Card>
      ) : null}
    </AppScreen>
  );
}

const styles = StyleSheet.create({ form: { gap: spacing.md } });
