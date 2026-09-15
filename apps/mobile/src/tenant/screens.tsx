import { Redirect, useFocusEffect, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { apiRequest } from "@/api/client";
import type { AuthContextsResponse } from "@/api/contracts";
import { useAuth } from "@/auth/AuthProvider";
import { AppScreen } from "@/components/layout/AppScreen";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { ActionGroup } from "@/components/ui/ActionGroup";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { IconButton } from "@/components/ui/IconButton";
import { MenuRow } from "@/components/ui/MenuRow";
import { useConfirmation } from "@/components/ui/ConfirmationProvider";
import { useContextNavigation } from "@/navigation/context-navigation";
import {
  useResponsiveStyles,
  useResponsiveTextStyles,
} from "@/theme/responsive";
import { canManageOrganization } from "@/domain/permissions";
import type {
  BusinessProfile,
  Role,
  TenantSummary,
  UserSummary,
} from "@/domain/types";
import { colors, spacing, textStyles } from "@/theme/tokens";
import { toUserFacingErrorMessage } from "@/utils/errors";
import { cacheTenantConfiguration } from "./configuration";

function useTask() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const run = async (work: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (reason) {
      setError(
        toUserFacingErrorMessage(
          reason,
          "Permintaan belum berhasil. Coba lagi.",
        ),
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function ErrorMessage({ message }: { message: string | null }) {
  const styles = useResponsiveStyles(baseStyles);
  return message ? (
    <Text accessibilityRole="alert" style={styles.error}>
      {message}
    </Text>
  ) : null;
}

function RolePicker({
  role,
  onChange,
  disabled = false,
}: {
  role: Role;
  onChange: (role: Role) => void;
  disabled?: boolean;
}) {
  const styles = useResponsiveStyles(baseStyles);
  const textStyles = useResponsiveTextStyles();
  return (
    <View style={styles.card}>
      <Text style={textStyles.label}>PERAN PENGGUNA</Text>
      <ActionGroup horizontal>
        {(["admin", "superadmin"] as const).map((value) => (
          <Button
            key={value}
            disabled={disabled}
            accessibilityState={{ selected: role === value, disabled }}
            variant={role === value ? "primary" : "secondary"}
            onPress={() => onChange(value)}
          >
            {value === "admin" ? "Admin" : "Superadmin"}
          </Button>
        ))}
      </ActionGroup>
      <Text style={styles.body}>
        {role === "admin"
          ? "Admin: transaksi, pembayaran, laporan, dan koreksi transaksi sendiri."
          : "Superadmin: seluruh transaksi, paket, pengguna, dan pengaturan bisnis."}
      </Text>
    </View>
  );
}

/** Only focused, authorized screens fetch; late responses cannot update a new context. */
function useRemote<T>(path: string, token?: string) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(token));
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const request = ++sequence.current;
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const next = await apiRequest<T>(path, { token });
      if (request === sequence.current) {
        setValue(next);
        setError(null);
      }
    } catch (reason) {
      if (request === sequence.current)
        setError(
          toUserFacingErrorMessage(
            reason,
            "Data belum dapat dimuat. Coba lagi.",
          ),
        );
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }, [path, token]);
  useFocusEffect(
    useCallback(() => {
      setValue(null);
      void reload();
      return () => {
        sequence.current += 1;
      };
    }, [reload]),
  );
  return { value, error, loading, reload, setValue };
}

function LoadingMessage({ children }: { children: string }) {
  const styles = useResponsiveStyles(baseStyles);
  return (
    <View
      style={styles.loading}
      accessibilityRole="progressbar"
      accessibilityLabel={children}
    >
      <ActivityIndicator color={colors.primary} />
      <Text style={styles.body}>{children}</Text>
    </View>
  );
}

/** Match Go's byte-length validation, including non-ASCII names/passwords. */
function byteLength(value: string) {
  return new TextEncoder().encode(value).length;
}

export function managedPasswordError(value: string): string | undefined {
  const size = byteLength(value);
  return size < 12 || size > 256
    ? "Kata sandi harus terdiri dari 12–256 karakter (huruf non-Latin dapat dihitung lebih panjang)."
    : undefined;
}

export function managedUsernameError(value: string): string | undefined {
  return /^[a-z0-9][a-z0-9._-]{2,63}$/.test(value.trim().toLowerCase())
    ? undefined
    : "Gunakan 3–64 huruf kecil, angka, titik, garis bawah, atau tanda hubung. Awali dengan huruf atau angka.";
}

export function ContextsScreen() {
  const styles = useResponsiveStyles(baseStyles);
  const textStyles = useResponsiveTextStyles();
  const router = useRouter();
  const { session, scopeLocked, notice, logout } = useAuth();
  const navigation = useContextNavigation();
  const { confirm } = useConfirmation();
  const contexts = useRemote<AuthContextsResponse>(
    "/auth/contexts",
    session?.token,
  );
  const task = useTask();
  if (!session) return <Redirect href="/(auth)/login" />;
  if (session.user.mustChangePassword)
    return <Redirect href="/(auth)/change-password" />;
  return (
    <AppScreen>
      <PageHeader
        title="Pilih bisnis"
        subtitle="Pilih tempat Anda bertransaksi"
        right={
          <IconButton
            icon="refresh"
            label="Muat ulang daftar bisnis"
            loading={contexts.loading}
            disabled={task.busy || navigation.busy}
            onPress={() => void contexts.reload()}
          />
        }
      />
      {scopeLocked ? (
        <Card style={styles.card}>
          <Text style={textStyles.heading}>
            Data belum tersinkron diamankan
          </Text>
          <Text style={styles.body}>
            {notice ??
              "Akses bisnis ini dihentikan. Anda dapat memilih bisnis lain tanpa menghapus antrean lama."}
          </Text>
        </Card>
      ) : null}
      <ErrorMessage message={contexts.error ?? task.error} />
      {contexts.loading ? (
        <LoadingMessage>Memuat daftar bisnis…</LoadingMessage>
      ) : null}
      {contexts.value?.tenants.length ? (
        <Card padded={false}>
          {contexts.value.tenants.map(({ tenant }) => {
            const selected = session.tenantId === tenant.id && !scopeLocked;
            return (
              <MenuRow
                key={tenant.id}
                icon="store-outline"
                title={tenant.name}
                selected={selected}
                {...(selected
                  ? {
                      status: `Sedang digunakan${session.dataMode === "sandbox" ? " • Mode uji" : ""}`,
                    }
                  : tenant.status !== "active"
                    ? { status: tenantStatusLabel(tenant.status) }
                    : {})}
                detail={selected ? "Lanjutkan bisnis ini" : "Buka bisnis"}
                disabled={
                  tenant.status !== "active" || task.busy || navigation.busy
                }
                accessibilityLabel={`${selected ? "Lanjutkan" : "Buka"} bisnis ${tenant.name}`}
                onPress={() => void navigation.openBusiness(tenant.id)}
              />
            );
          })}
        </Card>
      ) : null}
      {contexts.value?.tenants.length === 0 ? (
        <Text style={styles.body}>
          Belum ada bisnis aktif. Hubungi Superadmin untuk membuat atau
          mengaktifkan bisnis.
        </Text>
      ) : null}
      {contexts.value?.canManageOrganization ? (
        <View style={styles.businessSection}>
          <Text style={textStyles.label}>PENGELOLAAN</Text>
          <Card padded={false}>
            <MenuRow
              icon="store-cog-outline"
              title="Kelola tenant"
              detail="Daftar bisnis, nama, dan status"
              disabled={task.busy || navigation.busy}
              onPress={() =>
                void navigation.openManagement("/management/tenants")
              }
            />
            <MenuRow
              icon="account-group-outline"
              title="Pengguna"
              detail="Akun dan akses staf di seluruh bisnis"
              disabled={task.busy || navigation.busy}
              onPress={() =>
                void navigation.openManagement("/management/users")
              }
            />
          </Card>
        </View>
      ) : null}
      <Card padded={false}>
        <MenuRow
          destructive
          icon="logout"
          title="Keluar"
          disabled={navigation.busy || task.busy}
          onPress={() =>
            confirm({
              title: "Keluar dari akun?",
              message:
                "Anda perlu masuk kembali untuk menggunakan aplikasi. Data yang belum tersinkron tetap disimpan pada perangkat.",
              confirmLabel: "Keluar",
              destructive: true,
              onConfirm: () =>
                task.run(async () => {
                  await logout();
                  router.replace("/");
                }),
            })
          }
        />
      </Card>
    </AppScreen>
  );
}

function tenantStatusLabel(status: TenantSummary["status"]) {
  return status === "active"
    ? "Aktif"
    : status === "suspended"
      ? "Ditangguhkan"
      : "Menunggu aktivasi";
}

/** Visible entry point, not an automatic context exchange when a tab is focused. */
export function ManagementEntryScreen() {
  const styles = useResponsiveStyles(baseStyles);
  const { session } = useAuth();
  const navigation = useContextNavigation();
  if (!session) return <Redirect href="/(auth)/login" />;
  if (session.user.role !== "superadmin") return <Redirect href="/" />;
  return (
    <AppScreen>
      <PageHeader
        title="Pengguna"
        subtitle="Akun dan peran bersama untuk seluruh bisnis"
      />
      <Card style={styles.card}>
        <Text style={styles.body}>
          Pengelolaan akun berlaku untuk seluruh Pengelola Wisata Telomoyo,
          bukan hanya bisnis yang dipilih. Perubahan lokal akan disinkronkan
          sebelum membuka pengelolaan.
        </Text>
        <Button
          loading={navigation.busy}
          onPress={() => void navigation.openManagement("/management/users")}
        >
          Buka pengelolaan pengguna
        </Button>
      </Card>
    </AppScreen>
  );
}

export function ManagedTenantsScreen({ onBack }: { onBack?: () => void } = {}) {
  const styles = useResponsiveStyles(baseStyles);
  const textStyles = useResponsiveTextStyles();
  const router = useRouter();
  const navigation = useContextNavigation();
  const { confirm } = useConfirmation();
  const { session } = useAuth();
  const token = canManageOrganization(session) ? session.token : undefined;
  const tenants = useRemote<TenantSummary[]>("/management/tenants", token);
  const contexts = useRemote<AuthContextsResponse>("/auth/contexts", token);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [slug, setSlug] = useState("");
  const [editing, setEditing] = useState<TenantSummary | null>(null);
  const [editName, setEditName] = useState("");
  const task = useTask();
  if (!canManageOrganization(session)) return <Redirect href="/contexts" />;
  return (
    <AppScreen>
      <PageHeader
        back
        title="Kelola tenant"
        subtitle="Tambah, ubah nama, atau atur status bisnis"
        onBack={onBack ?? (() => void navigation.returnToBusiness())}
        right={
          <IconButton
            icon="refresh"
            label="Muat ulang daftar bisnis"
            loading={tenants.loading || contexts.loading}
            disabled={task.busy || navigation.busy}
            onPress={() =>
              void Promise.all([tenants.reload(), contexts.reload()])
            }
          />
        }
      />
      <ErrorMessage message={task.error ?? tenants.error ?? contexts.error} />
      {tenants.loading ? (
        <LoadingMessage>Memuat daftar bisnis…</LoadingMessage>
      ) : null}
      {tenants.value?.length === 0 ? (
        <Text style={styles.body}>
          Belum ada bisnis. Tambahkan bisnis pertama untuk mulai beroperasi.
        </Text>
      ) : null}
      {tenants.value?.length ? (
        <View style={styles.businessSection}>
          <Text style={textStyles.label}>DAFTAR BISNIS</Text>
          <Card padded={false}>
            {tenants.value.map((tenant) =>
              editing?.id === tenant.id ? null : (
                <MenuRow
                  key={tenant.id}
                  icon="store-outline"
                  title={tenant.name}
                  detail={tenant.slug}
                  status={tenantStatusLabel(tenant.status)}
                  disabled={task.busy || navigation.busy}
                  accessibilityLabel={`Kelola bisnis ${tenant.name}. ${tenantStatusLabel(tenant.status)}`}
                  onPress={() => {
                    setCreating(false);
                    setEditing(tenant);
                    setEditName(tenant.name);
                  }}
                />
              ),
            )}
          </Card>
        </View>
      ) : null}
      {editing ? (
        <Card key={editing.id} style={styles.card}>
          <Text style={textStyles.label}>UBAH BISNIS</Text>
          <Text style={textStyles.heading}>{editing.name}</Text>
          <Text style={styles.body}>
            {editing.slug} • {tenantStatusLabel(editing.status)}
          </Text>
          <Field
            label="Nama pengelolaan bisnis"
            value={editName}
            onChangeText={setEditName}
            editable={!task.busy}
            maxLength={160}
            hint="Kode bisnis tetap. Identitas struk, QRIS, dan struk lama tidak berubah."
          />
          <Button
            loading={task.busy}
            disabled={
              !editName.trim() ||
              byteLength(editName.trim()) > 160 ||
              editName.trim() === editing.name
            }
            onPress={() =>
              void task.run(async () => {
                await apiRequest(`/management/tenants/${editing.id}`, {
                  method: "PATCH",
                  token: session.token,
                  body: {
                    name: editName.trim(),
                    expectedRevision: editing.revision ?? 1,
                  },
                });
                setEditing(null);
                await tenants.reload();
              })
            }
          >
            Simpan nama
          </Button>
          <Button
            variant="danger"
            disabled={task.busy}
            onPress={() => setEditing(null)}
          >
            Batal
          </Button>
          <Button
            disabled={task.busy}
            variant={editing.status === "active" ? "danger" : "secondary"}
            onPress={() =>
              confirm({
                title:
                  editing.status === "active"
                    ? "Tangguhkan bisnis?"
                    : "Aktifkan bisnis?",
                message:
                  editing.status === "active"
                    ? "Akses operasional akan dihentikan. Antrean perangkat offline tetap disimpan dan diamankan saat terhubung kembali."
                    : "Semua akun aktif dapat memilih bisnis ini. Sesi yang telah dicabut tidak diaktifkan kembali.",
                confirmLabel:
                  editing.status === "active" ? "Tangguhkan" : "Aktifkan",
                destructive: editing.status === "active",
                onConfirm: () =>
                  task.run(async () => {
                    await apiRequest(
                      `/management/tenants/${editing.id}/status`,
                      {
                        method: "POST",
                        token: session.token,
                        body: {
                          status:
                            editing.status === "active"
                              ? "suspended"
                              : "active",
                        },
                      },
                    );
                    setEditing(null);
                    await tenants.reload();
                  }),
              })
            }
          >
            {editing.status === "active"
              ? "Tangguhkan bisnis"
              : "Aktifkan bisnis"}
          </Button>
        </Card>
      ) : null}
      {creating ? (
        <Card style={styles.card}>
          <Text style={textStyles.heading}>Tambah bisnis</Text>
          {contexts.value?.tenantProvisioningEnabled ? (
            <>
              <Field
                label="Nama bisnis"
                value={name}
                onChangeText={setName}
                editable={!task.busy}
                maxLength={160}
              />
              <Field
                label="Kode bisnis"
                value={slug}
                onChangeText={setSlug}
                editable={!task.busy}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={63}
                hint="2–63 huruf kecil, angka, dan tanda hubung. Awali dengan huruf/angka. Kode tidak dapat diubah."
              />
              <Button
                loading={task.busy}
                disabled={
                  !name.trim() ||
                  byteLength(name.trim()) > 160 ||
                  !/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug.trim().toLowerCase())
                }
                onPress={() =>
                  void task.run(async () => {
                    await apiRequest<TenantSummary>("/management/tenants", {
                      method: "POST",
                      token: session.token,
                      body: {
                        name: name.trim(),
                        slug: slug.trim().toLowerCase(),
                      },
                    });
                    setName("");
                    setSlug("");
                    setCreating(false);
                    await tenants.reload();
                  })
                }
              >
                Buat bisnis aktif
              </Button>
              <Button
                variant="danger"
                disabled={task.busy}
                onPress={() => {
                  setCreating(false);
                  setName("");
                  setSlug("");
                }}
              >
                Batal
              </Button>
              <Text style={styles.body}>
                Bisnis langsung dapat diakses semua staf dengan katalog kosong.
              </Text>
            </>
          ) : (
            <Text style={styles.body}>
              {contexts.value
                ? "Pembuatan bisnis belum diaktifkan pada server. Bisnis yang sudah ada tetap dapat dikelola."
                : "Memuat ketersediaan pembuatan bisnis…"}
            </Text>
          )}
        </Card>
      ) : contexts.value?.tenantProvisioningEnabled ? (
        <Button
          disabled={task.busy || navigation.busy}
          onPress={() => {
            setEditing(null);
            setCreating(true);
          }}
        >
          Tambah bisnis
        </Button>
      ) : (
        <Text style={styles.body}>
          {contexts.value
            ? "Pembuatan bisnis belum diaktifkan pada server. Bisnis yang sudah ada tetap dapat dikelola."
            : "Memuat ketersediaan pembuatan bisnis…"}
        </Text>
      )}
      <Text style={styles.body}>
        Tenant tidak dapat dihapus. Gunakan penangguhan untuk menghentikan
        operasional tanpa menghilangkan riwayat.
      </Text>
      <View style={styles.businessSection}>
        <Text style={textStyles.label}>PENGELOLAAN</Text>
        <Card padded={false}>
          <MenuRow
            icon="history"
            title="Riwayat pengelolaan"
            detail="Aktivitas administratif organisasi"
            onPress={() => router.push("/management/audit")}
          />
          <MenuRow
            icon="store-search-outline"
            title="Pilih bisnis"
            detail="Buka atau lanjutkan bisnis aktif"
            onPress={() => router.replace("/contexts")}
          />
        </Card>
      </View>
    </AppScreen>
  );
}

export function ManagedUsersScreen({
  onCreate,
  onOpenUser,
}: {
  onCreate?: () => void;
  onOpenUser?: (id: string) => void;
} = {}) {
  const styles = useResponsiveStyles(baseStyles);
  const router = useRouter();
  const navigation = useContextNavigation();
  const { session } = useAuth();
  const users = useRemote<UserSummary[]>(
    "/management/users",
    canManageOrganization(session) ? session.token : undefined,
  );
  const [search, setSearch] = useState("");
  if (!canManageOrganization(session)) return <Redirect href="/contexts" />;
  const query = search.trim().toLocaleLowerCase();
  const filteredUsers = users.value?.filter((user) =>
    `${user.fullName} ${user.username}`.toLocaleLowerCase().includes(query),
  );
  return (
    <AppScreen>
      <PageHeader
        title="Pengguna"
        subtitle="Kelola akun staf untuk seluruh bisnis"
        right={
          <IconButton
            icon="refresh"
            label="Muat ulang pengguna"
            loading={users.loading}
            disabled={navigation.busy}
            onPress={() => void users.reload()}
          />
        }
      />
      <Field
        label="Cari pengguna"
        value={search}
        onChangeText={setSearch}
        placeholder="Nama atau username"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
      />
      <Button
        disabled={navigation.busy}
        onPress={
          onCreate ??
          (() =>
            router.push({ pathname: "/users", params: { create: "true" } }))
        }
      >
        Tambah pengguna
      </Button>
      <ErrorMessage message={users.error} />
      {users.loading ? (
        <LoadingMessage>Memuat daftar pengguna…</LoadingMessage>
      ) : null}
      {!users.loading && users.value?.length === 0 ? (
        <Text style={styles.body}>
          Belum ada pengguna. Tambahkan akun untuk staf.
        </Text>
      ) : null}
      {!users.loading &&
      Boolean(users.value?.length) &&
      filteredUsers?.length === 0 ? (
        <Card style={styles.card}>
          <Text style={styles.body}>
            Tidak ada pengguna yang cocok dengan pencarian.
          </Text>
          <Button variant="secondary" onPress={() => setSearch("")}>
            Hapus pencarian
          </Button>
        </Card>
      ) : null}
      {filteredUsers?.length ? (
        <Card padded={false}>
          {filteredUsers.map((user) => (
            <MenuRow
              key={user.id}
              icon="account-outline"
              title={user.fullName}
              detail={`@${user.username}`}
              status={`${user.role === "superadmin" ? "Superadmin" : "Admin"} · ${user.active ? "Aktif" : "Nonaktif"}${user.id === session.user.id ? " · Anda" : ""}`}
              disabled={navigation.busy}
              accessibilityLabel={`Kelola akun ${user.fullName}. ${user.role === "superadmin" ? "Superadmin" : "Admin"}. ${user.active ? "Aktif" : "Nonaktif"}`}
              onPress={() =>
                onOpenUser
                  ? onOpenUser(user.id)
                  : router.push({
                      pathname: "/users",
                      params: { userId: user.id },
                    })
              }
            />
          ))}
        </Card>
      ) : null}
    </AppScreen>
  );
}

export function ManagedUserCreateScreen({
  onDone,
  onCancel,
}: {
  onDone?: () => void;
  onCancel?: () => void;
} = {}) {
  const styles = useResponsiveStyles(baseStyles);
  const { session } = useAuth();
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("admin");
  const task = useTask();
  const fullNameError =
    !fullName.trim() || byteLength(fullName.trim()) > 160
      ? "Isi nama lengkap, maksimal 160 karakter (huruf non-Latin dapat dihitung lebih panjang)."
      : undefined;
  const usernameError = managedUsernameError(username);
  const passwordError = managedPasswordError(password);
  if (!canManageOrganization(session)) return <Redirect href="/contexts" />;
  return (
    <AppScreen>
      <PageHeader
        back
        title="Tambah pengguna"
        subtitle="Akses otomatis ke semua bisnis aktif"
        onBack={onCancel}
      />
      <Card style={styles.card}>
        <Field
          label="Nama lengkap"
          value={fullName}
          onChangeText={setFullName}
          editable={!task.busy}
          maxLength={160}
          error={fullName ? fullNameError : undefined}
        />
        <Field
          label="Nama pengguna"
          value={username}
          onChangeText={setUsername}
          editable={!task.busy}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={64}
          error={username ? usernameError : undefined}
          hint="3–64 huruf kecil, angka, titik, garis bawah, atau tanda hubung."
        />
        <Field
          label="Kata sandi sementara"
          value={password}
          onChangeText={setPassword}
          editable={!task.busy}
          secureTextEntry
          autoComplete="new-password"
          error={password ? passwordError : undefined}
          hint="Minimal 12 karakter. Bagikan secara pribadi kepada pengguna."
        />
        <RolePicker role={role} onChange={setRole} disabled={task.busy} />
        <Text style={styles.body}>
          Bagikan kata sandi secara pribadi. Pengguna wajib menggantinya sebelum
          mulai beroperasi.
        </Text>
        <ErrorMessage message={task.error} />
        <Button
          loading={task.busy}
          disabled={Boolean(fullNameError || usernameError || passwordError)}
          onPress={() =>
            void task.run(async () => {
              await apiRequest("/management/users", {
                method: "POST",
                token: session.token,
                body: {
                  fullName: fullName.trim(),
                  username: username.trim().toLowerCase(),
                  role,
                  temporaryPassword: password,
                },
              });
              setPassword("");
              if (onDone) onDone();
              else router.replace("/users");
            })
          }
        >
          Buat akun
        </Button>
        <Button
          variant="danger"
          disabled={task.busy}
          onPress={() => {
            setPassword("");
            if (onCancel) onCancel();
            else router.back();
          }}
        >
          Batal
        </Button>
      </Card>
    </AppScreen>
  );
}

export function ManagedUserEditor({
  id,
  onBack,
}: {
  id: string;
  onBack?: () => void;
}) {
  const styles = useResponsiveStyles(baseStyles);
  const textStyles = useResponsiveTextStyles();
  const { confirm } = useConfirmation();
  const { session } = useAuth();
  const user = useRemote<UserSummary>(
    `/management/users/${encodeURIComponent(id)}`,
    canManageOrganization(session) ? session.token : undefined,
  );
  const [draftRole, setDraftRole] = useState<Role | null>(null);
  const [draftActive, setDraftActive] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const task = useTask();
  if (!canManageOrganization(session)) return <Redirect href="/contexts" />;
  const member = user.value;
  const self = session.user.id === id;
  const role = draftRole ?? member?.role ?? "admin";
  const active = draftActive ?? member?.active ?? false;
  return (
    <AppScreen>
      <PageHeader
        back
        title="Kelola akun"
        subtitle="Perubahan berlaku untuk seluruh bisnis"
        onBack={onBack}
      />
      <ErrorMessage message={task.error ?? user.error} />
      {user.loading ? <LoadingMessage>Memuat akun…</LoadingMessage> : null}
      {message ? (
        <Text accessibilityRole="alert" style={styles.body}>
          {message}
        </Text>
      ) : null}
      {!member ? (
        <Button
          variant="secondary"
          disabled={user.loading}
          onPress={() => void user.reload()}
        >
          Muat ulang akun
        </Button>
      ) : (
        <>
          <Card style={styles.card}>
            <Text style={textStyles.label}>IDENTITAS AKUN</Text>
            <Text style={textStyles.heading}>{member.fullName}</Text>
            <Text style={styles.body}>@{member.username}</Text>
            <Text style={styles.body}>
              Nama dan profil pribadi hanya dapat diubah oleh pemilik akun.
            </Text>
          </Card>
          <Card style={styles.card}>
            <Text style={textStyles.heading}>Akses pengguna</Text>
            <RolePicker
              role={role}
              onChange={setDraftRole}
              disabled={self || task.busy}
            />
            <View style={styles.toggle}>
              <View style={styles.flex}>
                <Text style={textStyles.label}>STATUS AKUN</Text>
                <Text style={styles.body}>
                  {active
                    ? "Aktif — dapat masuk dan memilih bisnis"
                    : "Nonaktif — akses seluruh bisnis dihentikan"}
                </Text>
              </View>
              <Switch
                accessibilityLabel="Akun aktif"
                value={active}
                disabled={self || task.busy}
                onValueChange={setDraftActive}
                trackColor={{ true: colors.primary }}
              />
            </View>
            <Text style={styles.body}>
              {self
                ? "Anda tidak dapat menurunkan peran atau menonaktifkan akun sendiri. Gunakan menu Ganti kata sandi untuk akun sendiri."
                : "Perubahan peran/status mencabut sesi akun di semua bisnis. Antrean offline tetap disimpan."}
            </Text>
            {!self ? (
              <Button
                loading={task.busy}
                disabled={role === member.role && active === member.active}
                onPress={() =>
                  confirm({
                    title: "Simpan akses akun?",
                    message:
                      "Akun perlu masuk kembali di semua perangkat. Perubahan berlaku di seluruh bisnis; antrean offline tetap disimpan.",
                    confirmLabel: "Simpan",
                    destructive: !active || role !== member.role,
                    onConfirm: () =>
                      task.run(async () => {
                        await apiRequest(`/management/users/${id}`, {
                          method: "PATCH",
                          token: session.token,
                          body: { role, active },
                        });
                        setDraftRole(null);
                        setDraftActive(null);
                        setMessage("Akses akun diperbarui.");
                        await user.reload();
                      }),
                  })
                }
              >
                Simpan akses akun
              </Button>
            ) : null}
          </Card>
          {!self ? (
            <Card style={styles.card}>
              <Text style={textStyles.heading}>Pemulihan kata sandi</Text>
              <Text style={styles.body}>
                Semua sesi akan dicabut. Pengguna wajib mengganti kata sandi
                sementara setelah masuk.
              </Text>
              <Field
                label="Kata sandi sementara baru"
                secureTextEntry
                value={password}
                onChangeText={setPassword}
                editable={!task.busy}
                autoComplete="new-password"
                error={password ? managedPasswordError(password) : undefined}
                hint="Minimal 12 karakter. Bagikan kata sandi secara pribadi."
              />
              <Button
                variant="danger"
                loading={task.busy}
                disabled={Boolean(managedPasswordError(password))}
                onPress={() =>
                  confirm({
                    title: "Reset kata sandi?",
                    message:
                      "Semua sesi akun dicabut. Pengguna wajib mengganti kata sandi sementara setelah masuk.",
                    confirmLabel: "Reset",
                    destructive: true,
                    onConfirm: () =>
                      task.run(async () => {
                        await apiRequest(
                          `/management/users/${id}/reset-password`,
                          {
                            method: "POST",
                            token: session.token,
                            body: { temporaryPassword: password },
                          },
                        );
                        setPassword("");
                        setMessage(
                          "Kata sandi direset. Bagikan kata sandi sementara secara pribadi.",
                        );
                        await user.reload();
                      }),
                  })
                }
              >
                Reset kata sandi
              </Button>
            </Card>
          ) : null}
        </>
      )}
    </AppScreen>
  );
}

interface ManagementAudit {
  id: string;
  eventType: string;
  createdAt: string;
}
export function ManagementAuditScreen() {
  const styles = useResponsiveStyles(baseStyles);
  const { session } = useAuth();
  const audit = useRemote<ManagementAudit[]>(
    "/management/audit",
    canManageOrganization(session) ? session.token : undefined,
  );
  if (!canManageOrganization(session)) return <Redirect href="/contexts" />;
  return (
    <AppScreen>
      <PageHeader
        back
        title="Riwayat pengelolaan"
        subtitle="Aktivitas administratif seluruh organisasi"
      />
      <ErrorMessage message={audit.error} />
      {audit.loading ? <LoadingMessage>Memuat riwayat…</LoadingMessage> : null}
      <Button
        variant="secondary"
        disabled={audit.loading}
        onPress={() => void audit.reload()}
      >
        Muat ulang riwayat
      </Button>
      {audit.value?.map((event) => (
        <Card key={event.id}>
          <Text style={styles.body}>{event.eventType}</Text>
          <Text style={styles.body}>
            {new Date(event.createdAt).toLocaleString("id-ID")}
          </Text>
        </Card>
      ))}
    </AppScreen>
  );
}

export function BusinessProfileScreen() {
  const styles = useResponsiveStyles(baseStyles);
  const { session } = useAuth();
  const allowed =
    session?.user.role === "superadmin" && session.dataMode === "production";
  const remote = useRemote<BusinessProfile>(
    "/tenant/profile",
    allowed ? session.token : undefined,
  );
  const [draft, setDraft] = useState<BusinessProfile | null>(null);
  const [saved, setSaved] = useState(false);
  const task = useTask();
  if (!allowed) return <Redirect href="/" />;
  const profile = draft ?? remote.value;
  return (
    <AppScreen>
      <PageHeader
        back
        title="Identitas struk"
        subtitle="Digunakan pada transaksi baru, struk, dan laporan"
      />
      <ErrorMessage message={task.error ?? remote.error} />
      {profile ? (
        <Card style={styles.card}>
          <Field
            label="Nama bisnis"
            value={profile.businessName}
            onChangeText={(businessName) => {
              setSaved(false);
              setDraft({ ...profile, businessName });
            }}
          />
          <Field
            label="Alamat (opsional)"
            value={profile.address ?? ""}
            onChangeText={(address) => {
              setSaved(false);
              setDraft({ ...profile, address });
            }}
          />
          <Field
            label="Telepon (opsional)"
            keyboardType="phone-pad"
            value={profile.phone ?? ""}
            onChangeText={(phone) => {
              setSaved(false);
              setDraft({ ...profile, phone });
            }}
          />
          <Button
            loading={task.busy}
            disabled={!profile.businessName.trim()}
            onPress={() =>
              void task.run(async () => {
                const value = await apiRequest<BusinessProfile>(
                  "/tenant/profile",
                  {
                    method: "PATCH",
                    token: session.token,
                    body: {
                      businessName: profile.businessName.trim(),
                      address: profile.address?.trim() || null,
                      phone: profile.phone?.trim() || null,
                      expectedRevision: profile.revision,
                    },
                  },
                );
                await cacheTenantConfiguration("profile", value, session);
                setDraft(value);
                setSaved(true);
              })
            }
          >
            Simpan identitas
          </Button>
          {saved ? (
            <Text style={styles.body}>
              Identitas tersimpan. Nama pengelolaan bisnis dan struk transaksi
              lama tidak berubah.
            </Text>
          ) : null}
        </Card>
      ) : (
        <Button variant="secondary" onPress={() => void remote.reload()}>
          Muat ulang identitas
        </Button>
      )}
    </AppScreen>
  );
}

const baseStyles = StyleSheet.create({
  card: { gap: spacing.md },
  businessSection: { gap: spacing.sm },
  body: { ...textStyles.body, color: colors.textMuted },
  error: { ...textStyles.body, color: colors.error },
  row: { flexDirection: "row", gap: spacing.sm },
  flex: { flex: 1 },
  loading: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  toggle: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
});
