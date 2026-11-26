import type { ConfigContext, ExpoConfig } from "expo/config";

const ANDROID_APPLICATION_ID = "com.fahmialfareza.sewamotorpos";
const appVersion = process.env.EXPO_APP_VERSION || "1.0.0";
const appVersionCode = process.env.EXPO_APP_VERSION_CODE || "1";
// Not a secret. The fallback lets EAS CLI commands (eas update, eas env:*)
// find the project, since they don't load the local .env file.
const easProjectId =
  process.env.EXPO_EAS_PROJECT_ID || "a1c4ac91-a553-4ec1-8c37-0824ea42d93d";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "Telomoyo POS",
  slug: "telomoyo-pos",
  version: appVersion,
  icon: "./assets/branding/app-icon.png",
  orientation: "portrait",
  userInterfaceStyle: "automatic",
  scheme: "sewamotor",
  android: {
    package: ANDROID_APPLICATION_ID,
    versionCode: parseInt(appVersionCode || "1", 10) || 1,
    adaptiveIcon: {
      backgroundColor: "#003D9B",
      foregroundImage: "./assets/branding/adaptive-icon.png",
      monochromeImage: "./assets/branding/monochrome-icon.png",
    },
    permissions: [
      "android.permission.BLUETOOTH",
      "android.permission.BLUETOOTH_ADMIN",
      "android.permission.BLUETOOTH_CONNECT",
      "android.permission.BLUETOOTH_SCAN",
      "android.permission.ACCESS_FINE_LOCATION",
    ],
    blockedPermissions: [
      "android.permission.READ_MEDIA_IMAGES",
      "android.permission.READ_MEDIA_VIDEO",
    ],
  },
  ios: {
    bundleIdentifier: "com.fahmialfareza.sewamotorpos",
    buildNumber: "2",
  },
  plugins: [
    "expo-router",
    "expo-status-bar",
    [
      "expo-splash-screen",
      {
        backgroundColor: "#003D9B",
        image: "./assets/branding/splash-icon.png",
        imageWidth: 200,
        resizeMode: "contain",
      },
    ],
    [
      "expo-sqlite",
      {
        useSQLCipher: true,
        enableFTS: true,
      },
    ],
    [
      "expo-secure-store",
      {
        configureAndroidBackup: true,
        faceIDPermission: "Izinkan Telomoyo POS mengakses kredensial aman.",
      },
    ],
    [
      "expo-camera",
      {
        cameraPermission:
          "Izinkan Telomoyo POS menggunakan kamera untuk membaca QRIS merchant.",
        microphonePermission: false,
        recordAudioAndroid: false,
        barcodeScannerEnabled: true,
      },
    ],
    [
      "expo-image-picker",
      {
        photosPermission: "Izinkan Telomoyo POS memilih gambar QRIS merchant.",
        cameraPermission: "Izinkan Telomoyo POS mengambil foto QRIS merchant.",
        microphonePermission: false,
      },
    ],
    "expo-background-task",
    "expo-sharing",
    "expo-font",
    "@react-native-community/datetimepicker",
    [
      "@sentry/react-native",
      {
        organization: "fahmi-alfareza",
        project: "telomoyo-pos-mobile",
        url: "https://sentry.io/",
        // Keep this config free of env-dependent values: it feeds the
        // fingerprint runtime version, which must match locally and on EAS.
        // EAS uploads source maps with the SENTRY_AUTH_TOKEN secret; for a
        // local release build without it, set SENTRY_DISABLE_AUTO_UPLOAD=true.
      },
    ],
    [
      "expo-build-properties",
      {
        android: {
          // R8 is on by default since SDK 58; keep it explicit alongside
          // resource shrinking, which is not.
          enableMinifyInReleaseBuilds: true,
          enableShrinkResourcesInReleaseBuilds: true,
          // Room instantiates generated *_Impl databases by name. Without
          // this, R8 strips WorkManager's WorkDatabase_Impl (pulled in by
          // expo-background-task) and the app crashes on launch.
          extraProguardRules: [
            "-keep class * extends androidx.room.RoomDatabase { <init>(); }",
            "-keepnames class * extends androidx.room.RoomDatabase",
          ].join("\n"),
        },
      },
    ],
  ],
  experiments: {
    typedRoutes: false,
  },
  extra: {
    apiUrl:
      process.env.EXPO_PUBLIC_API_BASE_URL ??
      process.env.EXPO_PUBLIC_API_URL ??
      "http://10.0.2.2:8000/api/v1",
    enableDemoLogin: process.env.EXPO_PUBLIC_ENABLE_DEMO_LOGIN === "true",
    eas: {
      projectId: easProjectId,
    },
  },
  // Fingerprint ties each OTA update to the exact native build it was made
  // for, so a JS bundle can never reach a binary with different native code.
  runtimeVersion: {
    policy: "fingerprint",
  },
  // Updates download in the background and apply on the next cold start, so
  // the app never blocks startup on the network or reloads mid-transaction.
  // Bundles must be signed with keys/private-key.pem (see README).
  updates: easProjectId
    ? {
        enabled: true,
        url: `https://u.expo.dev/${easProjectId}`,
        checkAutomatically: "ON_LOAD",
        fallbackToCacheTimeout: 0,
        codeSigningCertificate: "./certs/certificate.pem",
        codeSigningMetadata: {
          keyid: "main",
          alg: "rsa-v1_5-sha256",
        },
      }
    : { enabled: false },
});
