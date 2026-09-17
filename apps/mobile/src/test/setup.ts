jest.mock("react-native-keyboard-controller", () =>
  jest.requireActual("react-native-keyboard-controller/jest"),
);

afterEach(() => {
  jest.useRealTimers();
});

export {};
