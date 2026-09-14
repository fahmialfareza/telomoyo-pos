import * as ImagePicker from "expo-image-picker";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, Switch, Text, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { apiRequest } from "@/api/client";
import type { TenantQrisResponse } from "@/api/contracts";
import { INITIAL_TENANT_ID } from "@/domain/types";
import { cacheTenantConfiguration } from "@/tenant/configuration";
import { toUserFacingErrorMessage } from "@/utils/errors";

import { useAuth } from "@/auth/AuthProvider";
import { AppScreen } from "@/components/layout/AppScreen";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ActionGroup } from "@/components/ui/ActionGroup";
import { useConfirmation } from "@/components/ui/ConfirmationProvider";
import { Icon } from "@/components/ui/Icon";
import { StateView } from "@/components/ui/StateView";
import { readStaticQrisFromImage } from "@/domain/qris-image";
import { validateStaticQris, type ParsedQris } from "@/domain/qris";
import { readLegacyQrisConfig } from "@/security/secure-store";
import {
  colors,
  radius,
  spacing,
  textStyles,
  typography,
} from "@/theme/tokens";
import {
  useResponsiveStyles,
  useResponsiveTextStyles,
} from "@/theme/responsive";

const MAX_QRIS_IMAGE_BYTES = 25 * 1024 * 1024;
const QRIS_IMAGE_OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: ["images"],
  allowsEditing: true,
  aspect: [1, 1],
  quality: 1,
};

type PickerSource = "camera" | "gallery";

interface QrisSummaryCardProps {
  qris: ParsedQris;
  status: "candidate" | "saved";
}

function QrisSummaryCard({ qris, status }: QrisSummaryCardProps) {
  const styles = useResponsiveStyles(baseStyles);
  const textStyles = useResponsiveTextStyles();
  const saved = status === "saved";
  return (
    <Card style={saved ? styles.savedCard : styles.candidateCard}>
      <View style={styles.lockHeader}>
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={saved ? styles.lockIcon : styles.candidateIcon}
        >
          <Icon
            color={saved ? colors.success : colors.primary}
            name={saved ? "lock-check-outline" : "qrcode-scan"}
            size={24}
          />
        </View>
        <View style={styles.lockCopy}>
          <Text style={textStyles.label}>
            {saved ? "QRIS STATIS TERKUNCI" : "QRIS STATIS TERBACA"}
          </Text>
          <Text style={styles.lockHint}>
            {saved
              ? "Payload tidak dapat diedit manual."
              : "Periksa merchant sebelum menyimpan."}
          </Text>
        </View>
      </View>
      <View
        accessibilityLabel={`QRIS statis ${qris.merchantName}`}
        accessibilityRole="image"
        style={styles.qrFrame}
      >
        <QRCode
          backgroundColor="#FFFFFF"
          color="#000000"
          ecl="M"
          quietZone={24}
          size={184}
          value={qris.payload}
        />
      </View>
      <View style={styles.merchantCopy}>
        <Text style={styles.merchantName}>{qris.merchantName}</Text>
        <Text style={styles.merchantCity}>{qris.merchantCity}</Text>
      </View>
      <View
        accessibilityLabel="Payload QRIS statis hanya dapat dibaca"
        style={styles.payloadReference}
      >
        <Icon color={colors.textMuted} name="code-tags" size={16} />
        <Text numberOfLines={1} style={styles.payloadText}>
          {formatPayloadReference(qris.payload)}
        </Text>
      </View>
    </Card>
  );
}

function formatPayloadReference(payload: string): string {
  return `${payload.slice(0, 20)}…${payload.slice(-12)}`;
}

async function parseQrisImageAsset(
  asset: ImagePicker.ImagePickerAsset,
): Promise<ParsedQris> {
  if (asset.fileSize !== undefined && asset.fileSize > MAX_QRIS_IMAGE_BYTES) {
    throw new Error("Ukuran gambar QRIS maksimal 25 MB.");
  }
  if (
    asset.type !== undefined &&
    asset.type !== null &&
    asset.type !== "image" &&
    asset.type !== "livePhoto"
  ) {
    throw new Error("File yang dipilih harus berupa gambar.");
  }
  return readStaticQrisFromImage(asset.uri);
}

export default function QrisSettingsScreen() {
  const styles = useResponsiveStyles(baseStyles);
  const { confirm } = useConfirmation();
  const { session } = useAuth();
  const role = session?.user.role;
  const [saved, setSaved] = useState<ParsedQris | null>(null);
  const [revision, setRevision] = useState(0);
  const [legacy, setLegacy] = useState<ParsedQris | null>(null);
  const [activate, setActivate] = useState(true);
  const [candidate, setCandidate] = useState<ParsedQris | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [processingSource, setProcessingSource] = useState<PickerSource | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pickerActiveRef = useRef(false);
  const saveActiveRef = useRef(false);

  useEffect(() => {
    if (role !== "superadmin" || !session || session.dataMode === "sandbox") {
      return;
    }

    let active = true;
    void (async () => {
      const config = await apiRequest<TenantQrisResponse>("/tenant/qris", {
        token: session.token,
      });
      await cacheTenantConfiguration("qris", config, session);
      const selected = config.payloads.find(
        (item) => item.payloadHash === config.activePayloadHash,
      );
      const current = selected
        ? validateStaticQris(selected.staticPayload)
        : null;
      if (!active) return;
      setSaved(current);
      setRevision(config.revision);
      if (session.tenantId === INITIAL_TENANT_ID) {
        const previous = await readLegacyQrisConfig();
        if (
          previous &&
          active &&
          !config.payloads.some(
            (item) => item.staticPayload === previous.staticPayload,
          )
        )
          setLegacy(validateStaticQris(previous.staticPayload));
      }

      const pending = await ImagePicker.getPendingResultAsync();
      if (!active || !pending) return;
      if ("code" in pending) {
        throw new Error(pending.message);
      }
      if (pending.canceled) return;

      const asset = pending.assets[0];
      if (!asset) {
        throw new Error("Gambar QRIS tidak tersedia.");
      }
      const parsed = await parseQrisImageAsset(asset);
      if (!active) return;
      if (current?.payload === parsed.payload) {
        setMessage("QRIS dari gambar tersebut sudah tersimpan.");
        return;
      }
      setCandidate(parsed);
      setReplacing(current !== null);
      setMessage("Gambar dipulihkan. Periksa merchant sebelum menyimpan.");
    })()
      .catch((reason: unknown) => {
        if (!active) return;
        setError(
          reason instanceof Error
            ? reason.message
            : "Konfigurasi QRIS tidak dapat dibaca.",
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [role, session]);

  if (role !== "superadmin" || session?.dataMode === "sandbox") {
    return (
      <AppScreen>
        <PageHeader back title="QRIS Dinamis" />
        <StateView
          icon="shield-lock-outline"
          message={
            session?.dataMode === "sandbox"
              ? "Sumber QRIS merchant digunakan bersama dan hanya dapat diubah dari Mode Produksi."
              : "Hanya superadmin yang dapat mengubah identitas merchant QRIS."
          }
          title="Akses dibatasi"
        />
      </AppScreen>
    );
  }

  if (loading) {
    return (
      <AppScreen>
        <PageHeader back title="QRIS Dinamis" />
        <StateView
          icon="qrcode-scan"
          message="Memeriksa QRIS yang tersimpan pada perangkat."
          title="Menyiapkan QRIS"
        />
      </AppScreen>
    );
  }

  const stageImage = async (source: PickerSource) => {
    if (pickerActiveRef.current) return;
    pickerActiveRef.current = true;
    setProcessingSource(source);
    setMessage(null);
    setError(null);

    try {
      let result: ImagePicker.ImagePickerResult;
      if (source === "camera") {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          throw new Error(
            permission.canAskAgain
              ? "Izin kamera diperlukan untuk memotret QRIS."
              : "Izin kamera ditolak. Aktifkan izin Kamera melalui Pengaturan perangkat.",
          );
        }
        result = await ImagePicker.launchCameraAsync({
          ...QRIS_IMAGE_OPTIONS,
          cameraType: ImagePicker.CameraType.back,
        });
      } else {
        result = await ImagePicker.launchImageLibraryAsync(QRIS_IMAGE_OPTIONS);
      }

      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset) {
        throw new Error("Gambar QRIS tidak tersedia.");
      }
      const parsed = await parseQrisImageAsset(asset);
      if (saved?.payload === parsed.payload) {
        setCandidate(null);
        setReplacing(false);
        setMessage("QRIS dari gambar tersebut sudah tersimpan.");
        return;
      }
      setCandidate(parsed);
      setMessage("QRIS berhasil dibaca. Periksa merchant sebelum menyimpan.");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Gambar QRIS tidak dapat diproses.",
      );
    } finally {
      pickerActiveRef.current = false;
      setProcessingSource(null);
    }
  };

  const saveCandidate = async () => {
    if (!candidate || !session || saveActiveRef.current) return;
    saveActiveRef.current = true;
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const config = await apiRequest<TenantQrisResponse>("/tenant/qris", {
        method: "PUT",
        token: session.token,
        body: {
          expectedRevision: revision,
          staticPayload: candidate.payload,
          activate,
        },
      });
      await cacheTenantConfiguration("qris", config, session);
      const selected = config.payloads.find(
        (item) => item.payloadHash === config.activePayloadHash,
      );
      setSaved(selected ? validateStaticQris(selected.staticPayload) : null);
      setRevision(config.revision);
      if (legacy?.payload === candidate.payload) setLegacy(null);
      setCandidate(null);
      setReplacing(false);
      setMessage(
        activate
          ? "QRIS merchant tersimpan untuk bisnis ini dan akan tersinkron ke perangkat staf."
          : "Versi QRIS historis tersimpan. QRIS aktif tidak berubah.",
      );
      setActivate(true);
    } catch (reason) {
      setError(
        toUserFacingErrorMessage(
          reason,
          "Konfigurasi QRIS belum dapat disimpan. Periksa koneksi lalu coba lagi.",
        ),
      );
    } finally {
      saveActiveRef.current = false;
      setSaving(false);
    }
  };

  const cancelConfiguration = () => {
    setCandidate(null);
    setReplacing(false);
    setActivate(true);
    setError(null);
    setMessage(
      saved ? "Penggantian dibatalkan. QRIS sebelumnya tetap aktif." : null,
    );
  };

  const beginReplace = () => {
    confirm({
      title: "Ganti QRIS statis?",
      message:
        "QRIS baru digunakan untuk transaksi berikutnya. Versi sebelumnya tetap tersedia hanya untuk pembayaran historis yang terikat padanya.",
      confirmLabel: "Lanjutkan",
      onConfirm: () => {
        setReplacing(true);
        setActivate(true);
        setCandidate(null);
        setMessage(null);
        setError(null);
      },
    });
  };

  const processing = processingSource !== null;
  const showScanner = candidate === null && (saved === null || replacing);

  return (
    <AppScreen>
      <PageHeader
        back
        subtitle="Merchant QRIS khusus bisnis aktif"
        title="QRIS Dinamis"
      />
      <Card style={styles.info}>
        <Text style={styles.infoTitle}>Konfigurasi dari gambar</Text>
        <Text style={styles.infoText}>
          Ambil foto atau pilih gambar QRIS merchant. Pemindaian dilakukan
          langsung di perangkat; foto tidak diunggah atau disimpan. Aplikasi
          menyimpan payload statis tervalidasi di server bisnis, lalu
          menyinkronkannya ke penyimpanan terenkripsi perangkat.
        </Text>
      </Card>
      {legacy && !candidate ? (
        <Card style={styles.info}>
          <Text style={styles.infoTitle}>QRIS lama di perangkat ditemukan</Text>
          <Text style={styles.infoText}>
            Konfirmasi sebagai superadmin Telomoyo sebelum mengimpor merchant{" "}
            {legacy.merchantName}. QRIS ini belum otomatis digunakan pada
            bisnis.
          </Text>
          <Button
            variant="secondary"
            onPress={() => {
              setCandidate(legacy);
              setActivate(saved === null);
            }}
          >
            Tinjau dan impor QRIS lama
          </Button>
        </Card>
      ) : null}

      {candidate ? (
        <>
          <QrisSummaryCard qris={candidate} status="candidate" />
          <Text style={styles.reviewHint}>
            {saved
              ? "QRIS lama tetap aktif sampai konfigurasi baru disimpan."
              : "Payload hasil pemindaian terkunci dan tidak dapat diedit."}
          </Text>
          <View style={styles.activationRow}>
            <View style={styles.activationCopy}>
              <Text style={styles.activationLabel}>
                Gunakan untuk transaksi baru
              </Text>
              <Text style={styles.infoText}>
                {activate
                  ? "QRIS ini menjadi sumber aktif setelah disimpan."
                  : "Simpan sebagai versi historis saja; QRIS aktif tidak berubah."}
              </Text>
            </View>
            <Switch
              accessibilityLabel="Gunakan QRIS untuk transaksi baru"
              disabled={saving || processing}
              onValueChange={setActivate}
              trackColor={{ false: colors.outline, true: colors.primary }}
              value={activate}
            />
          </View>
          <ActionGroup>
            <Button
              disabled={processing}
              icon="content-save-check-outline"
              loading={saving}
              onPress={() => void saveCandidate()}
            >
              Simpan QRIS statis
            </Button>
            <Button
              disabled={saving || processing}
              icon="close"
              onPress={cancelConfiguration}
              variant="danger"
            >
              Batalkan
            </Button>
          </ActionGroup>
        </>
      ) : saved && !replacing ? (
        <>
          <QrisSummaryCard qris={saved} status="saved" />
          <Button
            disabled={saving}
            icon="swap-horizontal"
            onPress={beginReplace}
            variant="secondary"
          >
            Ganti QRIS statis
          </Button>
        </>
      ) : null}

      {showScanner ? (
        <Card style={styles.scannerCard}>
          <View style={styles.scannerIcon}>
            <Icon
              color={colors.primary}
              name="image-search-outline"
              size={30}
            />
          </View>
          <Text style={styles.scannerTitle}>
            {saved ? "Pindai QRIS pengganti" : "Tambahkan QRIS statis"}
          </Text>
          <Text style={styles.scannerText}>
            Potong gambar menjadi persegi dan pastikan kode QR memenuhi sebagian
            besar gambar agar mudah terbaca.
          </Text>
          <ActionGroup>
            <Button
              disabled={processing || saving}
              icon="camera-outline"
              loading={processingSource === "camera"}
              onPress={() => void stageImage("camera")}
            >
              Ambil foto QRIS
            </Button>
            <Button
              disabled={processing || saving}
              icon="image-outline"
              loading={processingSource === "gallery"}
              onPress={() => void stageImage("gallery")}
              variant="secondary"
            >
              Pilih gambar QRIS
            </Button>
            {saved ? (
              <Button
                disabled={processing || saving}
                icon="close"
                onPress={cancelConfiguration}
                variant="danger"
              >
                Batal mengganti
              </Button>
            ) : null}
          </ActionGroup>
        </Card>
      ) : null}

      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {message ? (
        <Text accessibilityRole="alert" style={styles.message}>
          {message}
        </Text>
      ) : null}
      <Text style={styles.disclaimer}>
        CRC mendeteksi payload rusak, tetapi bukan bukti merchant telah
        diverifikasi oleh bank atau acquirer. Status pembayaran tetap harus
        dikonfirmasi melalui aplikasi/acquirer merchant.
      </Text>
    </AppScreen>
  );
}

const baseStyles = StyleSheet.create({
  activationRow: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  activationCopy: { flex: 1, gap: spacing.xs },
  activationLabel: { ...textStyles.body, fontFamily: typography.bodySemibold },
  info: { gap: spacing.xs, backgroundColor: colors.primarySoft },
  infoTitle: { ...textStyles.heading, color: colors.primary },
  infoText: { ...textStyles.body, color: colors.textMuted },
  savedCard: { gap: spacing.md, backgroundColor: colors.successSoft },
  candidateCard: { gap: spacing.md, backgroundColor: colors.primarySoft },
  lockHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  lockIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.card,
  },
  candidateIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.card,
  },
  lockCopy: { flex: 1, gap: 2 },
  lockHint: { ...textStyles.body, color: colors.textMuted, fontSize: 12 },
  qrFrame: {
    alignSelf: "center",
    backgroundColor: "#FFFFFF",
    padding: spacing.sm,
    borderRadius: radius.lg,
  },
  merchantCopy: { alignItems: "center", gap: spacing.xs },
  merchantName: {
    fontFamily: typography.heading,
    fontSize: 20,
    color: colors.text,
    textAlign: "center",
  },
  merchantCity: { ...textStyles.body, color: colors.textMuted },
  payloadReference: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.card,
  },
  payloadText: {
    flex: 1,
    color: colors.textMuted,
    fontFamily: typography.mono,
    fontSize: 11,
  },
  reviewHint: {
    ...textStyles.body,
    color: colors.textMuted,
    textAlign: "center",
  },
  scannerCard: { gap: spacing.md, alignItems: "stretch" },
  scannerIcon: {
    width: 56,
    height: 56,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    backgroundColor: colors.primarySoft,
  },
  scannerTitle: {
    ...textStyles.heading,
    color: colors.text,
    textAlign: "center",
  },
  scannerText: {
    ...textStyles.body,
    color: colors.textMuted,
    textAlign: "center",
  },
  error: { ...textStyles.body, color: colors.error, textAlign: "center" },
  message: { ...textStyles.body, color: colors.success, textAlign: "center" },
  disclaimer: {
    ...textStyles.body,
    color: colors.textMuted,
    textAlign: "center",
    fontSize: 12,
  },
});
