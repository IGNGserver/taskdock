import { describe, expect, it } from 'vitest';

import {
  calendarDays,
  formatDate,
  formatMonth,
  isLocalDate,
  isMonth,
  safeTimezone,
  shiftLocalDate,
  shiftMonth,
  todayInTimezone,
  weekdayLabels,
} from '../src/date-utils.js';

describe('date utils', () => {
  it('accepts only real calendar dates and months', () => {
    expect(isLocalDate('2026-10-21')).toBe(true);
    expect(isLocalDate('2024-02-29')).toBe(true);
    expect(isLocalDate('2026-02-29')).toBe(false);
    expect(isLocalDate('2026-02-31')).toBe(false);
    expect(isLocalDate('2026-13-01')).toBe(false);
    expect(isLocalDate('2026-1-01')).toBe(false);
    expect(isLocalDate(null)).toBe(false);
    expect(isMonth('2026-10')).toBe(true);
    expect(isMonth('2026-13')).toBe(false);
    expect(isMonth('2026-1')).toBe(false);
  });

  it('falls back to a valid timezone instead of throwing', () => {
    expect(safeTimezone('Asia/Shanghai')).toBe('Asia/Shanghai');
    expect(safeTimezone('')).toBe('Asia/Shanghai');
    expect(safeTimezone('Not/AZone')).toBe('Asia/Shanghai');
    expect(todayInTimezone('Not/AZone')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(todayInTimezone(undefined)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('returns malformed input unchanged and never formats an invalid Date', () => {
    expect(formatDate('not-a-date')).toBe('not-a-date');
    expect(formatMonth('2026-13')).toBe('2026-13');
    expect(shiftMonth('2026-13', 1)).toBe('2026-13');
    expect(shiftLocalDate('not-a-date', 1)).toBe('not-a-date');
    expect(calendarDays('2026-13')).toEqual([]);
  });

  it('shifts valid dates across month and year boundaries', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftLocalDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftLocalDate('2024-02-28', 1)).toBe('2024-02-29');
  });

  it('builds six calendar weeks and the localized weekday order', () => {
    const days = calendarDays('2026-10', 1);
    expect(days).toHaveLength(42);
    expect(days.find((day) => day.date === '2026-10-01')).toMatchObject({
      inMonth: true,
      label: 1,
    });
    expect(weekdayLabels(1)[0]).toBe('一');
    expect(weekdayLabels(0)[0]).toBe('日');
  });
});
