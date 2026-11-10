// Date and time formatting in the laboratory time zone.
export const TIME_ZONE = 'Europe/Rome';

function parts(value, options) {
  const date = value instanceof Date ? value : new Date(value);
  const out = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, ...options })
    .formatToParts(date)
    .forEach((p) => { out[p.type] = p.value; });
  return out;
}

// DD.MM.YYYY
export function formatDate(value) {
  if (!value) return '';
  const p = parts(value, { day: '2-digit', month: '2-digit', year: 'numeric' });
  return `${p.day}.${p.month}.${p.year}`;
}

// HH:MM (24 h)
export function formatTime(value) {
  if (!value) return '';
  const p = parts(value, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return `${p.hour}:${p.minute}`;
}

// DD.MM.YYYY HH:MM
export function formatDateTime(value) {
  if (!value) return '';
  return `${formatDate(value)} ${formatTime(value)}`;
}
