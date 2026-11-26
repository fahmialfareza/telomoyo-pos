import * as Sentry from "@sentry/react-native";
import * as Updates from "expo-updates";

// The DSN is public by design: it only allows sending events to this project.
const SENTRY_DSN =
  process.env.EXPO_PUBLIC_SENTRY_DSN ??
  "https://ed92862bf4bc674d25290dd0fd2ed63a@o4504212419772416.ingest.us.sentry.io/4512500636254208";

Sentry.init({
  dsn: SENTRY_DSN,
  // Dev builds report through Metro/LogBox instead.
  enabled: !__DEV__,
  // The EAS Update channel ("production" / "preview") matches the build
  // profile, so issues can be filtered per release track.
  environment: Updates.channel || "development",
  // A POS handles customer and payment data: never attach IPs, cookies or
  // request bodies automatically.
  sendDefaultPii: false,
  // Crash and error reporting only; no performance tracing for now.
  tracesSampleRate: 0,
});

export { Sentry };
