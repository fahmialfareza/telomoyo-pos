import { useResponsiveStyles } from "@/theme/responsive";
import { useRouter } from "expo-router";
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
import { spacing } from "@/theme/tokens";

export default function NewPackageScreen() {
  const responsive = useResponsiveStyles(styles);
  const router = useRouter();
  const { session } = useAuth();
  const save = async (value: PackageFormValue) => {
    if (!session) return;
    await apiRequest("/packages", {
      method: "POST",
      token: session.token,
      body: {
        name: value.name,
        description: value.description,
        unitPrice: value.unitPrice,
      },
    });
    router.back();
  };
  return (
    <AppScreen>
      <PageHeader back title="Tambah Paket" />
      <Card style={responsive.form}>
        <PackageForm create onSubmit={save} />
      </Card>
    </AppScreen>
  );
}

const styles = StyleSheet.create({ form: { gap: spacing.md } });
