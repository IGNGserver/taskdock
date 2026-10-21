const FALLBACK_TIMEZONE = 'Asia/Shanghai';
const localDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const monthPattern = /^(\d{4})-(\d{2})$/;

/** A malformed URL date or a removed IANA zone must not throw inside render. */
export function isLocalDate(value: string | null | undefined): value is string {
  if (!value) return false;
  const match = localDatePattern.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function isMonth(value: string | null | undefined): value is string {
  if (!value) return false;
  const match = monthPattern.exec(value);
  if (!match) return false;
  const month = Number(match[2]);
  return month >= 1 && month <= 12;
}

export function safeTimezone(timezone: string | null | undefined): string {
  if (!timezone) return FALLBACK_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    return timezone;
  } catch {
    return FALLBACK_TIMEZONE;
  }
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function todayInTimezone(timezone: string | null | undefined): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: safeTimezone(timezone),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const result = `${values['year']}-${values['month']}-${values['day']}`;
    return isLocalDate(result) ? result : localDateKey(new Date());
  } catch {
    return localDateKey(new Date());
  }
}

export function formatDate(localDate: string): string {
  if (!isLocalDate(localDate)) return localDate;
  try {
    const date = new Date(`${localDate}T12:00:00`);
    return new Intl.DateTimeFormat('zh-CN', {
      month: 'long',
      day: 'numeric',
      weekday: 'long',
    }).format(date);
  } catch {
    return localDate;
  }
}

export function formatMonth(month: string): string {
  if (!isMonth(month)) return month;
  try {
    const date = new Date(`${month}-01T12:00:00`);
    return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long' }).format(date);
  } catch {
    return month;
  }
}

export function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  } catch {
    return value;
  }
}

export function shiftMonth(month: string, delta: number): string {
  if (!isMonth(month)) return month;
  const [year, monthNumber] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year!, monthNumber! - 1 + delta, 1));
  return date.toISOString().slice(0, 7);
}

export function shiftLocalDate(localDate: string, delta: number): string {
  if (!isLocalDate(localDate)) return localDate;
  const date = new Date(`${localDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

export function weekdayLabels(weekStartsOn: 0 | 1): string[] {
  const mondayFirst = ['一', '二', '三', '四', '五', '六', '日'];
  return weekStartsOn === 1 ? mondayFirst : ['日', ...mondayFirst.slice(0, 6)];
}

export interface CalendarDay {
  date: string;
  label: number;
  inMonth: boolean;
  taskCount: number;
}

export function calendarDays(month: string, weekStartsOn: 0 | 1 = 1): CalendarDay[] {
  if (!isMonth(month)) return [];
  const [year, monthNumber] = month.split('-').map(Number);
  const first = new Date(Date.UTC(year!, monthNumber! - 1, 1));
  const offset = weekStartsOn === 1 ? (first.getUTCDay() + 6) % 7 : first.getUTCDay();
  const daysInMonth = new Date(Date.UTC(year!, monthNumber!, 0)).getUTCDate();
  const previousDays = new Date(Date.UTC(year!, monthNumber! - 1, 0)).getUTCDate();
  return Array.from({ length: 42 }, (_, index) => {
    const dayIndex = index - offset + 1;
    const date = new Date(Date.UTC(year!, monthNumber! - 1, dayIndex));
    const inMonth = dayIndex >= 1 && dayIndex <= daysInMonth;
    return {
      date: date.toISOString().slice(0, 10),
      label: inMonth ? dayIndex : dayIndex < 1 ? previousDays + dayIndex : dayIndex - daysInMonth,
      inMonth,
      taskCount: 0,
    };
  });
}
