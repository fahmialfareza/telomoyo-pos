import { useReportingPeriodStore } from "@/reporting/period-store";

jest.mock("react-native-keyboard-controller", () =>
  jest.requireActual("react-native-keyboard-controller/jest"),
);

jest.mock("expo-haptics", () => ({
  selectionAsync: jest.fn(async () => undefined),
  notificationAsync: jest.fn(async () => undefined),
  NotificationFeedbackType: { Success: "success" },
}));

jest.mock("@shopify/flash-list", () => {
  const React = jest.requireActual("react");
  const { FlatList } = jest.requireActual("react-native");
  return {
    FlashList: React.forwardRef(function FlashListMock(
      props: object,
      ref: unknown,
    ) {
      return React.createElement(FlatList, {
        ...props,
        ref,
        initialNumToRender: 1000,
      });
    }),
  };
});

beforeEach(() => {
  // The reporting period is shared app state; start every test from "today".
  useReportingPeriodStore.getState().reset();
});

afterEach(() => {
  jest.useRealTimers();
});

export {};
