import { act, fireEvent, render, within } from "@testing-library/react-native";
import { Text, View } from "react-native";

import { DateMonthFilter } from "@/components/reporting/DateMonthFilter";
import {
  useReportingPeriod,
  useReportingPeriodStore,
} from "@/reporting/period-store";

// Stand-ins for Beranda and Riwayat: each wires its own filter to the shared
// period, exactly like the screens do.
function ScreenFilter({ testID }: { testID: string }) {
  const period = useReportingPeriod();
  return (
    <View testID={testID}>
      <DateMonthFilter
        date={period.date}
        mode={period.mode}
        month={period.month}
        onDateChange={period.setDate}
        onModeChange={period.setMode}
        onMonthChange={period.setMonth}
      />
    </View>
  );
}

function TwoScreens() {
  return (
    <>
      <ScreenFilter testID="beranda" />
      <ScreenFilter testID="riwayat" />
    </>
  );
}

describe("shared reporting period", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("switches every screen to Bulan and back to Tanggal together", () => {
    const screen = render(<TwoScreens />);
    const beranda = within(screen.getByTestId("beranda"));
    const riwayat = within(screen.getByTestId("riwayat"));

    fireEvent.press(beranda.getByRole("button", { name: "Bulan" }));
    expect(useReportingPeriodStore.getState().mode).toBe("month");
    expect(
      riwayat.getByRole("button", { name: /^Pilih bulan\./ }),
    ).toBeTruthy();

    fireEvent.press(riwayat.getByRole("button", { name: "Tanggal" }));
    expect(
      beranda.getByRole("button", { name: /^Pilih tanggal\./ }),
    ).toBeTruthy();
  });

  it("shares the picked day between screens", () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-08-01T05:00:00.000Z"));
    const screen = render(<TwoScreens />);

    fireEvent.press(
      within(screen.getByTestId("beranda")).getByRole("button", {
        name: "Tanggal sebelumnya",
      }),
    );

    expect(useReportingPeriodStore.getState().date).toBe("2026-07-31");
    expect(
      within(screen.getByTestId("riwayat")).getByRole("button", {
        name: /^Pilih tanggal\..*31/,
      }),
    ).toBeTruthy();
  });

  it("follows the current Jakarta day until a period is picked", () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-08-01T16:59:00.000Z"));
    function Probe() {
      const { mode, date, month } = useReportingPeriod();
      return <Text testID="period">{`${mode} ${date} ${month}`}</Text>;
    }
    const period = () => screen.getByTestId("period").props.children;
    const screen = render(<Probe />);
    expect(period()).toBe("date 2026-08-01 2026-08");

    // 00:00 WIB on 2 August.
    act(() => {
      jest.setSystemTime(new Date("2026-08-01T17:00:00.000Z"));
    });
    screen.rerender(<Probe />);
    expect(period()).toBe("date 2026-08-02 2026-08");

    act(() => {
      useReportingPeriodStore.getState().setDate("2026-07-15");
    });
    expect(period()).toBe("date 2026-07-15 2026-08");

    act(() => {
      useReportingPeriodStore.getState().reset();
    });
    expect(period()).toBe("date 2026-08-02 2026-08");
  });
});
