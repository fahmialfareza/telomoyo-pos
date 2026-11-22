import { create } from "zustand";

import {
  currentJakartaDate,
  currentJakartaMonth,
  type CalendarDateKey,
  type CalendarMonthKey,
  type ReportingMode,
} from "@/utils/time";

/** One reporting period shared by Beranda, Riwayat and Rekap, so switching
 * between Tanggal and Bulan (or picking a day/month) on one screen applies to
 * all of them. A null date/month means "today"/"this month" and is resolved at
 * render time, so a terminal left open past midnight follows the new day until
 * someone picks a specific period. */
interface ReportingPeriodState {
  mode: ReportingMode;
  date: CalendarDateKey | null;
  month: CalendarMonthKey | null;
  setMode: (mode: ReportingMode) => void;
  setDate: (date: CalendarDateKey) => void;
  setMonth: (month: CalendarMonthKey) => void;
  reset: () => void;
}

const initialPeriod = {
  mode: "date" as ReportingMode,
  date: null,
  month: null,
};

export const useReportingPeriodStore = create<ReportingPeriodState>((set) => ({
  ...initialPeriod,
  setMode: (mode) => set({ mode }),
  setDate: (date) => set({ date }),
  setMonth: (month) => set({ month }),
  reset: () => set(initialPeriod),
}));

export function useReportingPeriod() {
  const state = useReportingPeriodStore();
  return {
    ...state,
    date: state.date ?? currentJakartaDate(),
    month: state.month ?? currentJakartaMonth(),
  };
}
