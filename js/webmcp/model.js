// Pure helpers shared by the WebMCP tools and their tests.
// No network and no DOM here: dates, task status and lab-slot ranges only.
import { formatTime } from '../format.js';

export const SLOT_MINUTES = 30;
const SLOT_MS = SLOT_MINUTES * 60e3;
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

// Days since 1970-01-01 for a YYYY-MM-DD date (UTC arithmetic, no time zones).
export function dayNumber(isoDay) {
  const [y, m, d] = isoDay.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 864e5);
}

export function isoDate(day) {
  return new Date(day * 864e5).toISOString().slice(0, 10);
}

// 0 = Monday … 4 = Friday (weekend dates keep counting from Monday).
export function weekdayIndex(isoDay) {
  return (new Date(dayNumber(isoDay) * 864e5).getUTCDay() + 6) % 7;
}

export function mondayOf(isoDay) {
  return isoDate(dayNumber(isoDay) - weekdayIndex(isoDay));
}

// Same rule as the database view task_leaders and the Gantt page.
export function statusOf(task, today) {
  if (task.completed_on) return 'done';
  if (task.started_on) return today > task.end_date ? 'overdue' : 'progress';
  return today >= task.start_date ? 'late_start' : 'planned';
}

// Half-hour slots of a shift with free seats and supervisor coverage.
export function slotsOf(shift, now = Date.now()) {
  const bookings = shift.assignments ?? [];
  const out = [];
  for (let t = Date.parse(shift.starts_at); t < Date.parse(shift.ends_at); t += SLOT_MS) {
    const inSlot = bookings.filter((b) => Date.parse(b.starts_at) <= t && Date.parse(b.ends_at) > t);
    out.push({
      start: t,
      end: t + SLOT_MS,
      label: formatTime(new Date(t)),
      endLabel: formatTime(new Date(t + SLOT_MS)),
      free: shift.capacity - inSlot.filter((b) => b.role === 'participant').length,
      covered: inSlot.some((b) => b.role === 'supervisor'),
      started: t <= now,
    });
  }
  return out;
}

// Contiguous bookable ranges of a shift. A range breaks when seats run out,
// when supervision starts or stops, or when the shift has already started.
export function freeRanges(shift, now = Date.now()) {
  const ranges = [];
  let current = null;
  const close = () => { if (current) { ranges.push(current); current = null; } };
  for (const slot of slotsOf(shift, now)) {
    if (slot.started || slot.free <= 0) { close(); continue; }
    if (current && current.covered === slot.covered) {
      current.end = slot.end;
      current.endLabel = slot.endLabel;
      current.seats = Math.min(current.seats, slot.free);
    } else {
      close();
      current = {
        start: slot.start,
        end: slot.end,
        startLabel: slot.label,
        endLabel: slot.endLabel,
        seats: slot.free,
        covered: slot.covered,
      };
    }
  }
  close();
  return ranges;
}
