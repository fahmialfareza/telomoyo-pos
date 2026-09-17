import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AccessibilityInfo,
  Keyboard,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  View,
  findNodeHandle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAuthStore } from "@/auth/auth-store";
import { colors, radius } from "@/theme/tokens";
import {
  useResponsiveSizing,
  useResponsiveTextStyles,
} from "@/theme/responsive";
import { toUserFacingErrorMessage } from "@/utils/errors";

import { ActionGroup } from "./ActionGroup";
import { Button } from "./Button";

export interface ConfirmationOptions {
  title: string;
  message: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
}

const ConfirmationContext = createContext<{
  confirm: (options: ConfirmationOptions) => void;
} | null>(null);

/** Pending confirmations belong to the exact session that opened them. */
export function ConfirmationProvider({ children }: { children: ReactNode }) {
  const sessionId = useAuthStore((state) => state.session?.sessionId);
  const switching = useAuthStore((state) => state.switchingMode);
  const [pending, setPending] = useState<
    (ConfirmationOptions & { sessionId: string | undefined }) | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const sequence = useRef(0);
  const titleRef = useRef<Text>(null);
  const insets = useSafeAreaInsets();
  const sizing = useResponsiveSizing();
  const textStyles = useResponsiveTextStyles();

  const dismiss = useCallback(() => {
    sequence.current += 1;
    setPending(null);
    setError(null);
    setBusy(false);
    running.current = false;
  }, []);

  useEffect(() => {
    const unsubscribe = useAuthStore.subscribe((next, previous) => {
      if (
        next.session?.sessionId !== previous.session?.sessionId ||
        next.switchingMode !== previous.switchingMode
      )
        dismiss();
    });
    return () => {
      unsubscribe();
      sequence.current += 1;
    };
  }, [dismiss]);
  const confirm = useCallback((options: ConfirmationOptions) => {
    const state = useAuthStore.getState();
    if (state.switchingMode || running.current) return;
    Keyboard.dismiss();
    sequence.current += 1;
    setError(null);
    setPending({ ...options, sessionId: state.session?.sessionId });
  }, []);
  const context = useMemo(() => ({ confirm }), [confirm]);
  const visible =
    pending !== null && pending.sessionId === sessionId && !switching;

  const accept = async () => {
    if (!pending || running.current) return;
    const state = useAuthStore.getState();
    if (state.switchingMode || state.session?.sessionId !== pending.sessionId) {
      dismiss();
      return;
    }
    running.current = true;
    setBusy(true);
    setError(null);
    const request = sequence.current;
    try {
      await pending.onConfirm();
      if (request === sequence.current) dismiss();
    } catch (reason) {
      if (request !== sequence.current) return;
      running.current = false;
      // Clear busy before showing the error so retry is tappable in the same
      // paint. Splitting these updates left the confirm button disabled while
      // the alert was already visible.
      setBusy(false);
      setError(
        toUserFacingErrorMessage(
          reason,
          "Permintaan belum berhasil. Coba lagi.",
        ),
      );
    }
  };

  return (
    <ConfirmationContext.Provider value={context}>
      {children}
      <Modal
        transparent
        visible={visible}
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => {
          if (!running.current) dismiss();
        }}
        onShow={() => {
          const node = findNodeHandle(titleRef.current);
          if (node) AccessibilityInfo.setAccessibilityFocus(node);
        }}
      >
        <View
          style={[
            styles.overlay,
            {
              padding: sizing.gutter,
              paddingTop: insets.top + sizing.gutter,
              paddingBottom: insets.bottom + sizing.gutter,
            },
          ]}
        >
          <View
            accessibilityViewIsModal
            style={[
              styles.dialog,
              { padding: sizing.gutter, gap: sizing.sectionGap },
            ]}
          >
            <ScrollView
              style={styles.message}
              contentContainerStyle={{ gap: sizing.gap }}
            >
              <Text
                ref={titleRef}
                accessible
                accessibilityRole="header"
                style={textStyles.heading}
              >
                {pending?.title}
              </Text>
              <Text style={textStyles.body}>{pending?.message}</Text>
              {error ? (
                <Text
                  accessibilityRole="alert"
                  style={[textStyles.body, { color: colors.error }]}
                >
                  {error}
                </Text>
              ) : null}
            </ScrollView>
            <ActionGroup>
              <Button
                loading={busy}
                variant={pending?.destructive ? "dangerSolid" : "primary"}
                onPress={() => void accept()}
              >
                {pending?.confirmLabel ?? "Konfirmasi"}
              </Button>
              <Button disabled={busy} variant="danger" onPress={dismiss}>
                Batal
              </Button>
            </ActionGroup>
          </View>
        </View>
      </Modal>
    </ConfirmationContext.Provider>
  );
}

export function useConfirmation() {
  const context = useContext(ConfirmationContext);
  if (!context)
    throw new Error("ConfirmationProvider diperlukan untuk konfirmasi.");
  return context;
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
  },
  dialog: {
    width: "100%",
    maxWidth: 400,
    maxHeight: "100%",
    borderRadius: radius.lg,
    backgroundColor: colors.card,
    flexShrink: 1,
  },
  message: { flexShrink: 1 },
});
