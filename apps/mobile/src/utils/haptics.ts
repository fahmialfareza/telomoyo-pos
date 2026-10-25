import * as Haptics from "expo-haptics";

// Feedback is a nicety: devices without a vibrator, or with haptics disabled,
// must never surface an error to the cashier.

/** Light tick for adding or removing a package. */
export function tapHaptic(): void {
  void Haptics.selectionAsync().catch(() => undefined);
}

/** Confirms a saved sale without the cashier needing to look. */
export function successHaptic(): void {
  void Haptics.notificationAsync(
    Haptics.NotificationFeedbackType.Success,
  ).catch(() => undefined);
}
