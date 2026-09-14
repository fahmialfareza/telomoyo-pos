import { useResponsiveStyles } from "@/theme/responsive";
import DateTimePicker, {
  type DateTimePickerEvent,
} from "@react-native-community/datetimepicker";
import { useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import {
  colors,
  minimumTouchTarget,
  radius,
  spacing,
  textStyles,
  typography,
} from "@/theme/tokens";
import {
  calendarDateForPicker,
  calendarDateFromPicker,
  calendarMonthKey,
  currentJakartaDate,
  monthFromCalendarDate,
  parseCalendarMonthKey,
  shiftReportingSelection,
  type CalendarDateKey,
  type CalendarMonthKey,
  type ReportingMode,
} from "@/utils/time";

import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";

interface DateMonthFilterProps {
  mode: ReportingMode;
  date: CalendarDateKey;
  month: CalendarMonthKey;
  onModeChange: (mode: ReportingMode) => void;
  onDateChange: (date: CalendarDateKey) => void;
  onMonthChange: (month: CalendarMonthKey) => void;
  maximumDate?: CalendarDateKey;
}

const dateFormatter = new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta",
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

const monthFormatter = new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta",
  month: "long",
  year: "numeric",
});

const monthNameFormatter = new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta",
  month: "short",
});
const MONTH_NUMBERS = Array.from({ length: 12 }, (_, index) => index + 1);

function monthInstant(year: number, month: number): Date {
  return new Date(Date.UTC(year, month - 1, 1, 5));
}

function formatDate(date: CalendarDateKey): string {
  return dateFormatter.format(calendarDateForPicker(date));
}

function formatMonth(month: CalendarMonthKey): string {
  const { year, month: monthNumber } = parseCalendarMonthKey(month);
  return monthFormatter.format(monthInstant(year, monthNumber));
}

export function DateMonthFilter({
  mode,
  date,
  month,
  onModeChange,
  onDateChange,
  onMonthChange,
  maximumDate = currentJakartaDate(),
}: DateMonthFilterProps) {
  const responsive = useResponsiveStyles(styles);
  const maximumMonth = monthFromCalendarDate(maximumDate);
  const selection = mode === "date" ? date : month;
  const maximumSelection = mode === "date" ? maximumDate : maximumMonth;
  const selectedLabel = mode === "date" ? formatDate(date) : formatMonth(month);
  const [datePickerVisible, setDatePickerVisible] = useState(false);
  const [dateDraft, setDateDraft] = useState(() => calendarDateForPicker(date));
  const [monthPickerVisible, setMonthPickerVisible] = useState(false);
  const [monthPickerYear, setMonthPickerYear] = useState(
    () => parseCalendarMonthKey(month).year,
  );

  const openPicker = () => {
    if (mode === "date") {
      setDateDraft(calendarDateForPicker(date));
      setDatePickerVisible(true);
      return;
    }
    setMonthPickerYear(parseCalendarMonthKey(month).year);
    setMonthPickerVisible(true);
  };

  const moveSelection = (amount: -1 | 1) => {
    if (mode === "date") {
      onDateChange(shiftReportingSelection("date", date, amount));
    } else {
      onMonthChange(shiftReportingSelection("month", month, amount));
    }
  };

  const handleDateChange = (event: DateTimePickerEvent, next?: Date) => {
    if (Platform.OS === "android") setDatePickerVisible(false);
    if (event.type !== "set" || !next) return;

    if (Platform.OS === "ios") {
      setDateDraft(next);
    } else {
      onDateChange(calendarDateFromPicker(next));
    }
  };

  const mayMoveForward = selection < maximumSelection;

  return (
    <View
      accessibilityLabel="Filter periode laporan"
      style={responsive.container}
    >
      <View style={responsive.modeSelector}>
        <ModeButton
          label="Tanggal"
          onPress={() => onModeChange("date")}
          selected={mode === "date"}
        />
        <ModeButton
          label="Bulan"
          onPress={() => onModeChange("month")}
          selected={mode === "month"}
        />
      </View>

      <View style={responsive.selectionRow}>
        <PeriodArrow
          accessibilityLabel={
            mode === "date" ? "Tanggal sebelumnya" : "Bulan sebelumnya"
          }
          icon="chevron-left"
          onPress={() => moveSelection(-1)}
        />
        <Pressable
          accessibilityLabel={`Pilih ${mode === "date" ? "tanggal" : "bulan"}. Terpilih ${selectedLabel}`}
          accessibilityRole="button"
          onPress={openPicker}
          style={({ pressed }) => [
            responsive.selectionButton,
            pressed && responsive.pressed,
          ]}
        >
          <View style={responsive.selectionCopy}>
            <Text style={responsive.selectionCaption}>
              {mode === "date" ? "TANGGAL DIPILIH" : "BULAN DIPILIH"}
            </Text>
            <Text numberOfLines={1} style={responsive.selectionValue}>
              {selectedLabel}
            </Text>
          </View>
          <Icon
            color={colors.primary}
            name="calendar-month-outline"
            size={22}
          />
        </Pressable>
        <PeriodArrow
          accessibilityLabel={
            mode === "date" ? "Tanggal berikutnya" : "Bulan berikutnya"
          }
          disabled={!mayMoveForward}
          icon="chevron-right"
          onPress={() => moveSelection(1)}
        />
      </View>

      {datePickerVisible && Platform.OS === "android" ? (
        <DateTimePicker
          display="default"
          maximumDate={calendarDateForPicker(maximumDate)}
          mode="date"
          onChange={handleDateChange}
          timeZoneName="Asia/Jakarta"
          value={dateDraft}
        />
      ) : null}

      {datePickerVisible && Platform.OS === "ios" ? (
        <Modal
          animationType="fade"
          onRequestClose={() => setDatePickerVisible(false)}
          statusBarTranslucent
          transparent
          visible
        >
          <View style={responsive.modalBackdrop}>
            <View accessibilityViewIsModal style={responsive.modalCard}>
              <View style={responsive.modalHeading}>
                <View style={responsive.modalTitleCopy}>
                  <Text style={responsive.modalEyebrow}>PILIH TANGGAL</Text>
                  <Text style={responsive.modalTitle}>
                    {formatDate(calendarDateFromPicker(dateDraft))}
                  </Text>
                </View>
                <Pressable
                  accessibilityLabel="Tutup pemilih tanggal"
                  accessibilityRole="button"
                  onPress={() => setDatePickerVisible(false)}
                  style={responsive.closeButton}
                >
                  <Icon color={colors.textMuted} name="close" size={22} />
                </Pressable>
              </View>
              <DateTimePicker
                display="inline"
                maximumDate={calendarDateForPicker(maximumDate)}
                mode="date"
                onChange={handleDateChange}
                timeZoneName="Asia/Jakarta"
                value={dateDraft}
              />
              <Button
                onPress={() => {
                  onDateChange(calendarDateFromPicker(dateDraft));
                  setDatePickerVisible(false);
                }}
              >
                Terapkan tanggal
              </Button>
            </View>
          </View>
        </Modal>
      ) : null}

      {monthPickerVisible ? (
        <MonthPickerModal
          maximumMonth={maximumMonth}
          onClose={() => setMonthPickerVisible(false)}
          onSelect={(nextMonth) => {
            onMonthChange(nextMonth);
            setMonthPickerVisible(false);
          }}
          onYearChange={setMonthPickerYear}
          selectedMonth={month}
          year={monthPickerYear}
        />
      ) : null}
    </View>
  );
}

function ModeButton({
  label,
  onPress,
  selected,
}: {
  label: string;
  onPress: () => void;
  selected: boolean;
}) {
  const responsive = useResponsiveStyles(styles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        responsive.modeButton,
        selected && responsive.modeButtonSelected,
        pressed && responsive.pressed,
      ]}
    >
      <Text
        style={[
          responsive.modeButtonText,
          selected && responsive.modeButtonTextSelected,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function PeriodArrow({
  accessibilityLabel,
  disabled = false,
  icon,
  onPress,
}: {
  accessibilityLabel: string;
  disabled?: boolean;
  icon: "chevron-left" | "chevron-right";
  onPress: () => void;
}) {
  const responsive = useResponsiveStyles(styles);
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        responsive.arrowButton,
        disabled && responsive.disabled,
        pressed && responsive.pressed,
      ]}
    >
      <Icon color={colors.primary} name={icon} size={26} />
    </Pressable>
  );
}

function MonthPickerModal({
  maximumMonth,
  onClose,
  onSelect,
  onYearChange,
  selectedMonth,
  year,
}: {
  maximumMonth: CalendarMonthKey;
  onClose: () => void;
  onSelect: (month: CalendarMonthKey) => void;
  onYearChange: (year: number) => void;
  selectedMonth: CalendarMonthKey;
  year: number;
}) {
  const responsive = useResponsiveStyles(styles);
  const maximumYear = parseCalendarMonthKey(maximumMonth).year;

  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
      transparent
      visible
    >
      <View style={responsive.modalBackdrop}>
        <View accessibilityViewIsModal style={responsive.modalCard}>
          <View style={responsive.modalHeading}>
            <View style={responsive.modalTitleCopy}>
              <Text style={responsive.modalEyebrow}>PILIH BULAN</Text>
              <Text style={responsive.modalTitle}>Periode laporan</Text>
            </View>
            <Pressable
              accessibilityLabel="Tutup pemilih bulan"
              accessibilityRole="button"
              onPress={onClose}
              style={responsive.closeButton}
            >
              <Icon color={colors.textMuted} name="close" size={22} />
            </Pressable>
          </View>

          <View style={responsive.yearSelector}>
            <PeriodArrow
              accessibilityLabel="Tahun sebelumnya"
              disabled={year <= 1900}
              icon="chevron-left"
              onPress={() => onYearChange(year - 1)}
            />
            <Text style={responsive.yearValue}>{year}</Text>
            <PeriodArrow
              accessibilityLabel="Tahun berikutnya"
              disabled={year >= maximumYear}
              icon="chevron-right"
              onPress={() => onYearChange(year + 1)}
            />
          </View>

          <View style={responsive.monthGrid}>
            {MONTH_NUMBERS.map((monthNumber) => {
              const value = calendarMonthKey(year, monthNumber);
              const selected = value === selectedMonth;
              const disabled = value > maximumMonth;
              return (
                <Pressable
                  key={value}
                  accessibilityLabel={formatMonth(value)}
                  accessibilityRole="button"
                  accessibilityState={{ disabled, selected }}
                  disabled={disabled}
                  onPress={() => onSelect(value)}
                  style={({ pressed }) => [
                    responsive.monthButton,
                    selected && responsive.monthButtonSelected,
                    disabled && responsive.disabled,
                    pressed && responsive.pressed,
                  ]}
                >
                  <Text
                    style={[
                      responsive.monthButtonText,
                      selected && responsive.monthButtonTextSelected,
                    ]}
                  >
                    {monthNameFormatter.format(monthInstant(year, monthNumber))}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Button onPress={onClose} variant="danger">
            Batal
          </Button>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.sm,
  },
  modeSelector: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  modeButton: {
    minHeight: minimumTouchTarget,
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.outline,
    backgroundColor: colors.card,
  },
  modeButtonSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  modeButtonText: {
    ...textStyles.body,
    fontFamily: typography.bodyMedium,
  },
  modeButtonTextSelected: {
    color: colors.onPrimary,
  },
  selectionRow: {
    flexDirection: "row",
    alignItems: "stretch",
    gap: spacing.sm,
  },
  arrowButton: {
    width: minimumTouchTarget,
    minHeight: minimumTouchTarget,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.outline,
    backgroundColor: colors.card,
  },
  selectionButton: {
    minHeight: 60,
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
  },
  selectionCopy: {
    minWidth: 0,
    flex: 1,
    gap: 2,
  },
  selectionCaption: {
    ...textStyles.label,
    color: colors.primary,
  },
  selectionValue: {
    fontFamily: typography.bodySemibold,
    fontSize: 15,
    color: colors.text,
    textTransform: "capitalize",
  },
  modalBackdrop: {
    flex: 1,
    justifyContent: "center",
    padding: spacing.md,
    backgroundColor: "rgba(25, 27, 35, 0.48)",
  },
  modalCard: {
    width: "100%",
    maxWidth: 440,
    alignSelf: "center",
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.xl,
    backgroundColor: colors.card,
  },
  modalHeading: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  modalTitleCopy: {
    flex: 1,
    gap: spacing.xs,
  },
  modalEyebrow: {
    ...textStyles.label,
    color: colors.primary,
  },
  modalTitle: {
    ...textStyles.heading,
    textTransform: "capitalize",
  },
  closeButton: {
    width: minimumTouchTarget,
    height: minimumTouchTarget,
    alignItems: "center",
    justifyContent: "center",
  },
  yearSelector: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  yearValue: {
    fontFamily: typography.heading,
    fontSize: 22,
    color: colors.text,
  },
  monthGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  monthButton: {
    minHeight: minimumTouchTarget,
    flexBasis: "30%",
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.outline,
    backgroundColor: colors.card,
  },
  monthButtonSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  monthButtonText: {
    ...textStyles.body,
    fontFamily: typography.bodyMedium,
    textTransform: "capitalize",
  },
  monthButtonTextSelected: {
    color: colors.onPrimary,
  },
  pressed: {
    opacity: 0.72,
  },
  disabled: {
    opacity: 0.38,
  },
});
