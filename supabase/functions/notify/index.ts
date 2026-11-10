// J2050 Team Management - "notify" Edge Function (Supabase, Deno).
// Invoked every minute by pg_cron (migration 006). Each run:
//   1. calendar  - sends/updates/cancels the shift invitation (one invitation per shift,
//                  all participants as attendees) for shifts changed since the last run
//   2. reminders - e-mail to each participant 1 h before the shift start
//   3. leaders   - e-mail to a leader when tasks are newly assigned to him/her
//   4. deadlines - e-mail to the leader 7 days and 1 day before a task deadline
//   5. members   - e-mail to the admins when a registration awaits approval
// Secrets (Edge Functions > Secrets): SMTP_USER, SMTP_PASS, NOTIFY_SECRET, SITE_URL.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
import { createClient } from 'npm:@supabase/supabase-js@2';
import nodemailer from 'npm:nodemailer@6';

const TZ = 'Europe/Rome';
const SENDER_NAME = 'J2050 Team Management';
const SMTP_USER = Deno.env.get('SMTP_USER') ?? '';
const SMTP_PASS = Deno.env.get('SMTP_PASS') ?? '';
const NOTIFY_SECRET = Deno.env.get('NOTIFY_SECRET') ?? '';
const SITE_URL = (Deno.env.get('SITE_URL') ?? 'https://j2050space.github.io/internal/').replace(/\/?$/, '/');
const REMINDER_MINUTES = 60;
const DEADLINE_DAYS = [7, 1];
const DEADLINE_HOUR = 7;           // deadline notices sent from 07:00 (Rome)
const BATCH = 20;                  // shifts synchronised per run

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

const mailer = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

/* ---------- formatting ---------- */
function zoned(value: string | Date) {
  const out: Record<string, string> = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(new Date(value)).forEach((p) => { out[p.type] = p.value; });
  return out;
}
const fDate = (v: string | Date) => { const p = zoned(v); return `${p.day}.${p.month}.${p.year}`; };
const fTime = (v: string | Date) => { const p = zoned(v); return `${p.hour}:${p.minute}`; };
const fDay = (v: string | Date) => `${zoned(v).weekday} ${fDate(v)}`;
const romeDate = (v: string | Date) => { const p = zoned(v); return `${p.year}-${p.month}-${p.day}`; };
const isoDay = (d: string) => { const [y, m, dd] = d.split('-'); return `${dd}.${m}.${y}`; };
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/* ---------- e-mail ---------- */
async function send(to: string[], subject: string, text: string, icalEvent?: { method: string; content: string }) {
  if (!to.length) return;
  await mailer.sendMail({
    from: `"${SENDER_NAME}" <${SMTP_USER}>`,
    to: to.join(', '),
    subject,
    text: `${text}\n\n--\n${SENDER_NAME}\n${SITE_URL}\nAutomatic message: do not reply.`,
    ...(icalEvent ? { icalEvent: { filename: 'invite.ics', ...icalEvent } } : {}),
  });
}

/* ---------- iCalendar ---------- */
const icsText = (s: string) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsTime = (v: string | Date) => new Date(v).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
function fold(line: string) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let current = '';
  for (const ch of line) {
    if (new TextEncoder().encode(current + ch).length > (parts.length ? 74 : 75)) { parts.push(current); current = ''; }
    current += ch;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

type Person = { id: string; email: string; name: string; supervisor?: boolean; seq?: number };
type Content = { summary: string; start: string; end: string; location: string | null; description: string };

// One invitation per person and shift: UID = shift + person
function ics(method: 'REQUEST' | 'CANCEL', shiftId: number, person: Person, sequence: number, c: Content) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//J2050//Team Management//EN', 'CALSCALE:GREGORIAN', `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:shift-${shiftId}-${person.id}@j2050-team-management`,
    `DTSTAMP:${icsTime(new Date())}`,
    `SEQUENCE:${sequence}`,
    `DTSTART:${icsTime(c.start)}`,
    `DTEND:${icsTime(c.end)}`,
    `SUMMARY:${icsText(c.summary)}`,
    ...(c.location ? [`LOCATION:${icsText(c.location)}`] : []),
    `DESCRIPTION:${icsText(c.description)}`,
    `ORGANIZER;CN="${SENDER_NAME}":mailto:${SMTP_USER}`,
    `ATTENDEE;CN="${person.name.replace(/"/g, "'")}";ROLE=${person.supervisor ? 'CHAIR' : 'REQ-PARTICIPANT'};PARTSTAT=NEEDS-ACTION;RSVP=FALSE:mailto:${person.email}`,
    `STATUS:${method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
    ...(method === 'REQUEST'
      ? ['BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Lab shift in 1 hour', `TRIGGER:-PT${REMINDER_MINUTES}M`, 'END:VALARM']
      : []),
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

/* ---------- 1. calendar invitations ---------- */
const SHIFT_SELECT = 'id, starts_at, ends_at, location, description, notes, supervisor_id, ' +
  'supervisor:profiles!shifts_supervisor_id_fkey(email, full_name), tasks(code, name), ' +
  'assignments(user_id, created_at, profiles(email, full_name))';

// Supervisor first, then participants in booking order
function people(shift: any): Person[] {
  const sup: Person[] = shift.supervisor_id && shift.supervisor?.email
    ? [{ id: shift.supervisor_id, email: shift.supervisor.email, name: shift.supervisor.full_name ?? shift.supervisor.email, supervisor: true }]
    : [];
  return sup.concat(participants(shift));
}

function participants(shift: any): Person[] {
  return (shift.assignments ?? [])
    .slice().sort((a: any, b: any) => (a.created_at < b.created_at ? -1 : 1))
    .filter((a: any) => a.profiles?.email)
    .map((a: any) => ({ id: a.user_id, email: a.profiles.email, name: a.profiles.full_name ?? a.profiles.email }));
}

function contentOf(shift: any, attendees: Person[]): Content {
  const task = shift.tasks ? `${shift.tasks.code} ${shift.tasks.name}` : 'Lab shift';
  const description = [
    `Task: ${task}`,
    shift.description ? `Work to do: ${shift.description}` : '',
    shift.notes ? `Notes: ${shift.notes}` : '',
    `Supervisor: ${attendees.find((a) => a.supervisor)?.name ?? 'not set'}`,
    `Participants: ${attendees.filter((a) => !a.supervisor).map((a) => a.name).join(', ') || 'none yet'}`,
    `Details: ${SITE_URL}shifts.html`,
  ].filter(Boolean).join('\n');
  return { summary: `Lab shift – ${task}`, start: shift.starts_at, end: shift.ends_at, location: shift.location, description };
}

const whenText = (c: Content) => `${fDay(c.start)}, ${fTime(c.start)}–${fTime(c.end)}`;

// Invitations are personal: each person receives only the messages that concern him/her.
//   new person in the shift          -> invitation to that person only
//   person removed / booking cancelled -> cancellation to that person only
//   shift details changed (time, task, location, work, notes) -> update to everyone in the shift
//   shift deleted                    -> cancellation to everyone
// The participants list in the description is the one at the time of sending.
const coreHash = (shift: any) => JSON.stringify({
  start: shift.starts_at, end: shift.ends_at, location: shift.location, description: shift.description,
  notes: shift.notes, task: shift.tasks ? `${shift.tasks.code} ${shift.tasks.name}` : null,
});

async function processCalendar() {
  const { data: dirty, error } = await db.from('calendar_dirty').select('shift_id, marked_at').order('marked_at').limit(BATCH);
  if (error) throw error;
  const now = new Date();
  let sent = 0;
  for (const d of dirty ?? []) {
    const { data: shift, error: e1 } = await db.from('shifts').select(SHIFT_SELECT).eq('id', d.shift_id).maybeSingle();
    if (e1) throw e1;
    const { data: state, error: e2 } = await db.from('calendar_state').select('*').eq('shift_id', d.shift_id).maybeSingle();
    if (e2) throw e2;
    const prev: Person[] = state?.attendees ?? [];

    if (!shift) {
      // Shift deleted: cancellation to everyone (future shifts only)
      if (state?.content && new Date(state.content.end) > now) {
        for (const p of prev) {
          await send([p.email], `Cancelled: ${state.content.summary} (${whenText(state.content)})`,
            `The lab shift of ${whenText(state.content)} has been deleted.`,
            { method: 'CANCEL', content: ics('CANCEL', d.shift_id, p, (p.seq ?? 0) + 1, state.content) });
          sent += 1;
        }
      }
      await db.from('calendar_state').delete().eq('shift_id', d.shift_id);
    } else if (new Date(shift.ends_at) <= now) {
      // Past shift (e.g. no-show removed by an admin): no message
    } else {
      const current = people(shift);
      const content = contentOf(shift, current);
      const hash = coreHash(shift);
      const changed = Boolean(state) && state.hash !== hash;
      const saved: Person[] = [];
      // Last sequence used for each person whose invitation was cancelled
      // (a new booking of the same person shall have a higher sequence)
      const cancelled: Record<string, number> = { ...(state?.cancelled ?? {}) };

      for (const r of prev.filter((p) => !current.some((c) => c.id === p.id && Boolean(c.supervisor) === Boolean(p.supervisor)))) {
        // Removed, or role changed (supervisor <-> participant): cancel the old invitation
        await send([r.email], `Cancelled: ${content.summary} (${whenText(content)})`,
          `You are no longer ${r.supervisor ? 'the supervisor of' : 'booked on'} the lab shift of ${whenText(content)}.`,
          { method: 'CANCEL', content: ics('CANCEL', d.shift_id, r, (r.seq ?? 0) + 1, content) });
        cancelled[r.id] = (r.seq ?? 0) + 1;
        sent += 1;
      }

      for (const c of current) {
        const old = prev.find((p) => p.id === c.id && Boolean(p.supervisor) === Boolean(c.supervisor));
        const roleText = c.supervisor ? 'You are the supervisor of this lab shift.' : 'You are booked on this lab shift.';
        if (!old) {
          // New person (or a person cancelled earlier who books again: higher sequence)
          const seq = cancelled[c.id] !== undefined ? cancelled[c.id] + 1 : 0;
          await send([c.email], `${content.summary} (${whenText(content)})`,
            `${roleText}\n\nWhen: ${whenText(content)}\n${content.location ? `Location: ${content.location}\n` : ''}${content.description}`,
            { method: 'REQUEST', content: ics('REQUEST', d.shift_id, c, seq, content) });
          saved.push({ ...c, seq });
          sent += 1;
        } else if (changed) {
          const seq = (old.seq ?? 0) + 1;
          await send([c.email], `Updated: ${content.summary} (${whenText(content)})`,
            `The lab shift has been updated. ${roleText}\n\nWhen: ${whenText(content)}\n` +
            `${content.location ? `Location: ${content.location}\n` : ''}${content.description}`,
            { method: 'REQUEST', content: ics('REQUEST', d.shift_id, c, seq, content) });
          saved.push({ ...c, seq });
          sent += 1;
        } else {
          saved.push({ ...c, seq: old.seq ?? 0 });
        }
      }

      const { error: e3 } = await db.from('calendar_state').upsert({
        shift_id: d.shift_id, attendees: saved, content, hash, cancelled, updated_at: new Date().toISOString(),
      });
      if (e3) throw e3;
    }
    // Remove the mark only if the shift has not changed again in the meantime
    await db.from('calendar_dirty').delete().eq('shift_id', d.shift_id).lte('marked_at', d.marked_at);
  }
  return sent;
}

/* ---------- 2. reminders 1 h before the shift ---------- */
async function processReminders() {
  const now = new Date();
  const until = new Date(now.getTime() + REMINDER_MINUTES * 60e3);
  const { data: shifts, error } = await db.from('shifts').select(SHIFT_SELECT)
    .gt('starts_at', now.toISOString()).lte('starts_at', until.toISOString());
  if (error) throw error;
  let sent = 0;
  for (const s of shifts ?? []) {
    const attendees = people(s);
    const keys = attendees.map((a) => `reminder:${s.id}:${a.id}:${Date.parse(s.starts_at)}`);
    if (!keys.length) continue;
    const { data: done } = await db.from('notification_log').select('key').in('key', keys);
    const already = new Set((done ?? []).map((x: any) => x.key));
    const content = contentOf(s, attendees);
    for (let i = 0; i < attendees.length; i += 1) {
      if (already.has(keys[i])) continue;
      await send([attendees[i].email], `Reminder: ${content.summary} at ${fTime(s.starts_at)}`,
        `Your lab shift${attendees[i].supervisor ? ' (as supervisor)' : ''} starts at ${fTime(s.starts_at)} (${fDay(s.starts_at)}).\n\n` +
        `${content.location ? `Location: ${content.location}\n` : ''}${content.description}`);
      await db.from('notification_log').insert({ key: keys[i] });
      sent += 1;
    }
  }
  return sent;
}

/* ---------- tasks and leaders ---------- */
async function openTasksWithLeader() {
  const [t, l, p] = await Promise.all([
    db.from('tasks').select('id, code, name, end_date, status, notified_leader_id').neq('status', 'done'),
    db.from('task_leaders').select('task_id, leader_id'),
    db.from('profiles').select('id, email, full_name'),
  ]);
  const error = t.error || l.error || p.error;
  if (error) throw error;
  const leaderOf = new Map((l.data ?? []).map((x: any) => [x.task_id, x.leader_id]));
  const person = new Map((p.data ?? []).map((x: any) => [x.id, x]));
  return { tasks: (t.data ?? []).map((x: any) => ({ ...x, leader_id: leaderOf.get(x.id) ?? null })), person };
}

const taskLine = (t: any) => `- ${t.code} ${t.name} (deadline ${isoDay(t.end_date)})`;

/* ---------- 3. new task assignments ---------- */
async function processAssignments() {
  const { tasks, person } = await openTasksWithLeader();
  const changed = tasks.filter((t: any) => t.leader_id !== t.notified_leader_id);
  const byLeader = new Map<string, any[]>();
  changed.filter((t: any) => t.leader_id).forEach((t: any) => {
    if (!byLeader.has(t.leader_id)) byLeader.set(t.leader_id, []);
    byLeader.get(t.leader_id)!.push(t);
  });
  let sent = 0;
  for (const [leaderId, list] of byLeader) {
    const leader = person.get(leaderId);
    if (!leader?.email) continue;
    list.sort((a, b) => (a.end_date < b.end_date ? -1 : 1));
    await send([leader.email], list.length === 1
      ? `Task assigned to you: ${list[0].code} ${list[0].name}`
      : `${list.length} tasks assigned to you`,
    `The following task${list.length === 1 ? ' is' : 's are'} now assigned to you as leader:\n\n` +
      `${list.map(taskLine).join('\n')}\n\nProject plan: ${SITE_URL}gantt.html`);
    sent += 1;
    for (const t of list) await db.from('tasks').update({ notified_leader_id: leaderId }).eq('id', t.id);
  }
  // Tasks left without leader: align the bookkeeping silently
  for (const t of changed.filter((x: any) => !x.leader_id)) {
    await db.from('tasks').update({ notified_leader_id: null }).eq('id', t.id);
  }
  return sent;
}

/* ---------- 4. deadline notices ---------- */
async function processDeadlines() {
  if (Number(zoned(new Date()).hour) < DEADLINE_HOUR) return 0;
  const today = romeDate(new Date());
  const targets = new Map(DEADLINE_DAYS.map((n) => [addDays(today, n), n]));
  const { tasks, person } = await openTasksWithLeader();
  const due = tasks.filter((t: any) => t.leader_id && targets.has(t.end_date))
    .map((t: any) => ({ ...t, days: targets.get(t.end_date), key: `deadline:${targets.get(t.end_date)}:${t.id}:${t.end_date}:${t.leader_id}` }));
  if (!due.length) return 0;
  const { data: done } = await db.from('notification_log').select('key').in('key', due.map((t: any) => t.key));
  const already = new Set((done ?? []).map((x: any) => x.key));
  const byLeader = new Map<string, any[]>();
  due.filter((t: any) => !already.has(t.key)).forEach((t: any) => {
    if (!byLeader.has(t.leader_id)) byLeader.set(t.leader_id, []);
    byLeader.get(t.leader_id)!.push(t);
  });
  let sent = 0;
  for (const [leaderId, list] of byLeader) {
    const leader = person.get(leaderId);
    if (!leader?.email) continue;
    const tomorrow = list.filter((t) => t.days === 1);
    const week = list.filter((t) => t.days === 7);
    const text = [
      tomorrow.length ? `Deadline TOMORROW:\n${tomorrow.map(taskLine).join('\n')}` : '',
      week.length ? `Deadline in 7 days:\n${week.map(taskLine).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
    await send([leader.email], tomorrow.length ? 'Task deadline tomorrow' : 'Task deadline in 7 days',
      `${text}\n\nProject plan: ${SITE_URL}gantt.html`);
    await db.from('notification_log').insert(list.map((t) => ({ key: t.key })));
    sent += 1;
  }
  return sent;
}

/* ---------- 5. registrations awaiting approval ---------- */
async function processRegistrations() {
  const { data: pending, error } = await db.rpc('pending_registrations');
  if (error) throw error;
  if (!pending?.length) return 0;
  const keys = pending.map((p: any) => `registration:${p.id}`);
  const { data: done } = await db.from('notification_log').select('key').in('key', keys);
  const already = new Set((done ?? []).map((x: any) => x.key));
  const fresh = pending.filter((p: any) => !already.has(`registration:${p.id}`));
  if (!fresh.length) return 0;
  const { data: admins, error: e2 } = await db.from('profiles').select('email').eq('role', 'admin').eq('status', 'active');
  if (e2) throw e2;
  const to = (admins ?? []).map((a: any) => a.email).filter(Boolean);
  if (!to.length) return 0;
  await send(to, fresh.length === 1 ? 'New registration awaiting approval' : `${fresh.length} registrations awaiting approval`,
    `The following account${fresh.length === 1 ? ' is' : 's are'} awaiting approval:\n\n` +
    `${fresh.map((p: any) => `- ${p.full_name ?? '(name not entered yet)'} <${p.email}>`).join('\n')}\n\n` +
    `Approve or reject: ${SITE_URL}members.html`);
  await db.from('notification_log').insert(fresh.map((p: any) => ({ key: `registration:${p.id}` })));
  return 1;
}

/* ---------- entry point ---------- */
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function step(fn: () => Promise<number>) {
  try { return await fn(); } catch (err) { console.error(fn.name, err); return `error: ${(err as Error)?.message ?? err}`; }
}

Deno.serve(async (req) => {
  if (!NOTIFY_SECRET || req.headers.get('x-notify-secret') !== NOTIFY_SECRET) {
    return json({ error: 'forbidden' }, 403);
  }
  const body = await req.json().catch(() => ({}));

  if (body.action === 'test') {
    try {
      await send([String(body.to)], 'J2050 Team Management – test', 'Test message: the notification service can send e-mails.');
      return json({ test: 'sent' });
    } catch (err) {
      return json({ test: 'failed', error: (err as Error)?.message ?? String(err) }, 500);
    }
  }

  const { data: claimed, error } = await db.rpc('claim_notify_lease', { p_seconds: 120 });
  if (error) return json({ error: error.message }, 500);
  if (!claimed) return json({ skipped: 'another run in progress' });
  const report: Record<string, unknown> = {};
  try {
    report.calendar = await step(processCalendar);
    report.reminders = await step(processReminders);
    report.leaders = await step(processAssignments);
    report.deadlines = await step(processDeadlines);
    report.members = await step(processRegistrations);
  } finally {
    await db.rpc('release_notify_lease');
  }
  return json(report);
});
