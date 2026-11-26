// Start crash reporting before anything else can throw.
import "./src/observability/sentry";

// Background tasks must be defined before Expo Router registers the app entry.
import "./src/sync/background";

// Keep this import last so all entry-point side effects run first.
import "expo-router/entry";
