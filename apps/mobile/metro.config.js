// Adds Sentry debug IDs to bundles so uploaded source maps match the
// JS that runs on devices, including EAS Update bundles.
const { getSentryExpoConfig } = require("@sentry/react-native/metro");

module.exports = getSentryExpoConfig(__dirname);
