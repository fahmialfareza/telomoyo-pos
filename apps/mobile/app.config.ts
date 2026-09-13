import type { ConfigContext, ExpoConfig } from "expo/config";

const ANDROID_APPLICATION_ID = "com.fahmialfareza.sewamotorpos";
const appVersion = process.env.EXPO_APP_VERSION || "1.0.0";
const appVersionCode = process.env.EXPO_APP_VERSION_CODE || "1";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "Telomoyo POS",
  slug: "telomoyo-pos",
  version: appVersion,
  icon: "./assets/branding/app-icon.png",
  orientation: "portrait",
  userInterfaceStyle: "light",
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
      projectId: process.env.EAS_PROJECT_ID,
    },
  },
  runtimeVersion: {
    policy: "appVersion",
  },
  updates: {
    enabled: false,
  },
});
