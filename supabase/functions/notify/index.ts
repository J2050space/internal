// J2050 Team Management - "notify" Edge Function (Supabase, Deno).
// Invoked every minute by pg_cron (migration 006). Each run:
//   1. calendar  - personal invitation (own booked hours) sent/updated/cancelled for
//                  the bookings changed since the last run
//   2. reminders - e-mail to each booked person 1 h before his/her own hours
//   3. leaders   - once a day from 07:00: e-mail to a leader with the tasks assigned to
//                  him/her or taken away since the day before (net changes only)
//   4. deadlines - e-mail to the leader 7 days and 1 day before a task deadline
//   5. overdue   - e-mail to the leader and to the admins the day after a task deadline
//                  passed without completion
//   6. documents - e-mail to the responsible 14, 7 and 1 days before the data package
//                  of a milestone is due, for each required document not delivered;
//                  summary to the document managers (admins and SYS leader)
//   7. members   - e-mail to the admins when a registration awaits approval
//   8. events    - e-mails for the events queued by the database (migration 013):
//                  accounts, department leaders, shift requests, document reviews
//                  and responsibles. The person who caused an event is never notified.
// Invitations (1) and events (8) wait QUIET_MINUTES without changes of the shift or
// object, then only the net change is sent: mistakes corrected at once send nothing.
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
const DEADLINE_HOUR = 7;           // deadline, overdue and document notices sent from 07:00 (Rome)
const OVERDUE_WINDOW = 7;          // overdue notice only for deadlines passed in the last 7 days
const DOC_DUE_DAYS = [14, 7, 1];   // notices before the data package of a milestone is due
const BATCH = 20;                  // shifts synchronised per run
const QUIET_MINUTES = 5;           // invitations and events sent only after 5 minutes without changes
const EVENT_BATCH = 30;            // groups of queued events handled per run
const MAX_ATTEMPTS = 5;            // failed attempts before an event is left aside

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
  if (!to.length) return 0;
  await mailer.sendMail({
    from: `"${SENDER_NAME}" <${SMTP_USER}>`,
    to: to.join(', '),
    subject,
    text: `${text}\n\n--\n${SENDER_NAME}\n${SITE_URL}\nAutomatic message: do not reply.`,
    ...(icalEvent ? { icalEvent: { filename: 'invite.ics', ...icalEvent } } : {}),
  });
  return 1;
}

/* ---------- people ---------- */
type Profile = { id: string; email: string | null; full_name: string | null; role: string; status: string };
const PROFILE_COLS = 'id, email, full_name, role, status';
const nameOf = (p?: Profile | null) => (p ? p.full_name ?? p.email ?? '?' : 'nobody');

async function profilesById(ids: (string | null | undefined)[]) {
  const list = [...new Set(ids.filter(Boolean))] as string[];
  if (!list.length) return new Map<string, Profile>();
  const { data, error } = await db.from('profiles').select(PROFILE_COLS).in('id', list);
  if (error) throw error;
  return new Map((data ?? []).map((p: Profile) => [p.id, p]));
}

async function activeAdmins(): Promise<Profile[]> {
  const { data, error } = await db.from('profiles').select(PROFILE_COLS).eq('role', 'admin').eq('status', 'active');
  if (error) throw error;
  return data ?? [];
}

// Admins who receive a notice "for admins" (preferences, migration 013).
// Notices: registrations, shift_requests, tasks_overdue, doc_review, doc_due.
// A notice muted by every admin goes to all the admins: it is never lost.
async function adminsFor(notice: string): Promise<Profile[]> {
  const admins = await activeAdmins();
  if (!admins.length) return admins;
  const { data, error } = await db.from('notification_prefs').select('user_id, muted').in('user_id', admins.map((a) => a.id));
  if (error) throw error;
  const muted = new Set((data ?? []).filter((p: any) => (p.muted ?? []).includes(notice)).map((p: any) => p.user_id));
  const list = admins.filter((a) => !muted.has(a.id));
  return list.length ? list : admins;
}

// Document managers receiving the summary of the documents due: the admins
// who want it and the leader of the SYS department
async function docManagers(): Promise<Profile[]> {
  const list = await adminsFor('doc_due');
  const { data, error } = await db.from('team_leaders').select('leader_id').eq('team', 'SYS').maybeSingle();
  if (error) throw error;
  if (data?.leader_id && !list.some((p) => p.id === data.leader_id)) {
    const sys = (await profilesById([data.leader_id])).get(data.leader_id);
    if (sys?.status === 'active' && ['teamleader', 'admin'].includes(sys.role)) list.push(sys);
  }
  return list;
}

// Addresses of the recipients, without the person who caused the event
const emailsOf = (people: (Profile | null | undefined)[], actor?: string | null) =>
  [...new Set(people.filter((p): p is Profile => !!p?.email && p.id !== actor).map((p) => p.email!))];

/* ---------- documents ---------- */
const vv = (n: number) => `V${String(n).padStart(2, '0')}`;
const docBase = (d: any) => `${d.subteam}_${d.doc_type}_${d.title}`;
const docLink = (id: number) => `${SITE_URL}documents.html#doc=${id}`;
const msDue = (m: any): string | null => m.docs_due ?? m.review_date ?? null;
const VERSION_STATUS: Record<string, string> = {
  in_progress: 'in progress', in_review: 'in review', approved: 'approved, to be sent to ESA',
  sent: 'sent to ESA', esa_accepted: 'accepted by ESA', esa_changes: 'changes required by ESA',
};
const LEVEL: Record<string, string> = { draft: 'draft', release: 'release', update: 'update', ad_hoc: 'ad hoc' };

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

type Person = { id: string; email: string; name: string; supervisor: boolean; start: string; end: string; seq?: number; hash?: string; content?: Content };
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
// One personal invitation per person and shift, with the person's own hours
// (bookings cover whole-hour slots of the shift; supervisors are admins).
//   new booking                       -> invitation to that person only
//   own hours or role changed         -> update to that person only
//   booking cancelled / removed       -> cancellation to that person only
//   shift details changed (task, location, work, notes) -> update to everyone booked
//   shift deleted                     -> cancellation to everyone booked
const SHIFT_SELECT = 'id, starts_at, ends_at, location, description, notes, tasks(code, name), ' +
  'assignments(user_id, role, starts_at, ends_at, created_at, profiles(email, full_name))';

// Supervisors first, then participants; each with own hours
function people(shift: any): Person[] {
  return (shift.assignments ?? [])
    .filter((a: any) => a.profiles?.email)
    .map((a: any) => ({
      id: a.user_id, email: a.profiles.email, name: a.profiles.full_name ?? a.profiles.email,
      supervisor: a.role === 'supervisor', start: a.starts_at, end: a.ends_at, created: a.created_at,
    }))
    .sort((x: any, y: any) => (x.supervisor === y.supervisor ? (x.created < y.created ? -1 : 1) : x.supervisor ? -1 : 1));
}

const hours = (p: Person) => `${fTime(p.start)}\u2013${fTime(p.end)}`;

// requestNote: note of the admin who approved the request of this person
function contentFor(shift: any, person: Person, all: Person[], requestNote: string | null = null): Content {
  const task = shift.tasks ? `${shift.tasks.code} ${shift.tasks.name}` : 'Lab shift';
  const list = (sup: boolean) => all.filter((x) => x.supervisor === sup).map((x) => `${x.name} (${hours(x)})`).join(', ');
  const description = [
    `Your hours: ${hours(person)} as ${person.supervisor ? 'supervisor' : 'participant'}`,
    `Shift: ${fTime(shift.starts_at)}\u2013${fTime(shift.ends_at)}`,
    `Task: ${task}`,
    shift.description ? `Work to do: ${shift.description}` : '',
    shift.notes ? `Notes: ${shift.notes}` : '',
    requestNote ? `Note on your request: ${requestNote}` : '',
    `Supervisors: ${list(true) || 'none'}`,
    `Participants: ${list(false) || 'none yet'}`,
    `Details: ${SITE_URL}shifts.html`,
  ].filter(Boolean).join('\n');
  return { summary: `Lab ${person.supervisor ? 'supervision' : 'shift'} \u2013 ${task}`, start: person.start, end: person.end,
    location: shift.location, description };
}

const whenText = (c: Content) => `${fDay(c.start)}, ${fTime(c.start)}\u2013${fTime(c.end)}`;

// What makes an invitation out of date for one person (not the list of the others)
const personHash = (shift: any, p: Person) => JSON.stringify({
  start: p.start, end: p.end, role: p.supervisor, location: shift.location, description: shift.description,
  notes: shift.notes, task: shift.tasks ? `${shift.tasks.code} ${shift.tasks.name}` : null,
});

async function processCalendar() {
  // Only shifts without changes in the last QUIET_MINUTES (marked_at = last change)
  const quiet = new Date(Date.now() - QUIET_MINUTES * 60e3).toISOString();
  const { data: dirty, error } = await db.from('calendar_dirty').select('shift_id, marked_at')
    .lte('marked_at', quiet).order('marked_at').limit(BATCH);
  if (error) throw error;
  const now = new Date();
  let sent = 0;
  for (const d of dirty ?? []) {
    const { data: shift, error: e1 } = await db.from('shifts').select(SHIFT_SELECT).eq('id', d.shift_id).maybeSingle();
    if (e1) throw e1;
    const { data: state, error: e2 } = await db.from('calendar_state').select('*').eq('shift_id', d.shift_id).maybeSingle();
    if (e2) throw e2;
    const prev: Person[] = state?.attendees ?? [];
    const cancelled: Record<string, number> = { ...(state?.cancelled ?? {}) };

    const cancel = async (p: Person, text: string) => {
      if (!p.content || new Date(p.end) <= now) return;   // nothing to cancel for past hours
      const seq = (p.seq ?? 0) + 1;
      await send([p.email], `Cancelled: ${p.content.summary} (${whenText(p.content)})`, text,
        { method: 'CANCEL', content: ics('CANCEL', d.shift_id, p, seq, p.content) });
      cancelled[p.id] = seq;
      sent += 1;
    };

    if (!shift) {
      for (const p of prev) await cancel(p, `The lab shift of ${whenText(p.content!)} has been deleted.`);
      await db.from('calendar_state').delete().eq('shift_id', d.shift_id);
    } else if (new Date(shift.ends_at) <= now) {
      // Past shift (e.g. no-show removed by an admin): no message
    } else {
      const current = people(shift);
      const saved: Person[] = [];
      // Shift created by approving a request: the note of the admin goes in the requester's invitation
      const { data: reqs, error: e4 } = await db.from('shift_requests').select('requested_by, admin_note')
        .eq('shift_id', d.shift_id).eq('status', 'approved').limit(1);
      if (e4) throw e4;
      const request = reqs?.[0] ?? null;

      for (const r of prev.filter((p) => !current.some((c) => c.id === p.id))) {
        await cancel(r, `You are no longer booked on the lab shift of ${whenText(r.content!)}.`);
      }

      for (const c of current) {
        const old = prev.find((p) => p.id === c.id);
        const hash = personHash(shift, c);
        const content = contentFor(shift, c, current, request?.requested_by === c.id ? request.admin_note : null);
        const intro = c.supervisor ? 'You are booked as supervisor of a lab shift.' : 'You are booked on a lab shift.';
        const body = (lead: string) => `${lead}\n\nYour hours: ${whenText(content)}\n` +
          `${content.location ? `Location: ${content.location}\n` : ''}${content.description}`;
        if (new Date(c.end) <= now) {
          saved.push({ ...c, seq: old?.seq ?? 0, hash: old?.hash ?? hash, content: old?.content ?? content });
        } else if (!old) {
          const seq = cancelled[c.id] !== undefined ? cancelled[c.id] + 1 : 0;
          await send([c.email], `${content.summary} (${whenText(content)})`, body(intro),
            { method: 'REQUEST', content: ics('REQUEST', d.shift_id, c, seq, content) });
          saved.push({ ...c, seq, hash, content });
          sent += 1;
        } else if (old.hash !== hash) {
          const seq = (old.seq ?? 0) + 1;
          await send([c.email], `Updated: ${content.summary} (${whenText(content)})`, body(`Your lab shift has been updated. ${intro}`),
            { method: 'REQUEST', content: ics('REQUEST', d.shift_id, c, seq, content) });
          saved.push({ ...c, seq, hash, content });
          sent += 1;
        } else {
          saved.push({ ...c, seq: old.seq ?? 0, hash: old.hash, content: old.content });
        }
      }

      const { error: e3 } = await db.from('calendar_state').upsert({
        shift_id: d.shift_id, attendees: saved, cancelled, updated_at: new Date().toISOString(),
      });
      if (e3) throw e3;
    }
    // Remove the mark only if the shift has not changed again in the meantime
    await db.from('calendar_dirty').delete().eq('shift_id', d.shift_id).lte('marked_at', d.marked_at);
  }
  return sent;
}

/* ---------- 2. reminders 1 h before the own booked hours ---------- */
async function processReminders() {
  const now = new Date();
  const until = new Date(now.getTime() + REMINDER_MINUTES * 60e3);
  const { data: shifts, error } = await db.from('shifts').select(SHIFT_SELECT)
    .lte('starts_at', until.toISOString()).gt('ends_at', now.toISOString());
  if (error) throw error;
  let sent = 0;
  for (const s of shifts ?? []) {
    const all = people(s);
    const due = all.filter((p) => new Date(p.start) > now && new Date(p.start) <= until);
    if (!due.length) continue;
    const keys = due.map((p) => `reminder:${s.id}:${p.id}:${Date.parse(p.start)}`);
    const { data: done } = await db.from('notification_log').select('key').in('key', keys);
    const already = new Set((done ?? []).map((x: any) => x.key));
    for (let i = 0; i < due.length; i += 1) {
      if (already.has(keys[i])) continue;
      const content = contentFor(s, due[i], all);
      await send([due[i].email], `Reminder: ${content.summary} at ${fTime(due[i].start)}`,
        `Your lab hours${due[i].supervisor ? ' as supervisor' : ''} start at ${fTime(due[i].start)} (${fDay(due[i].start)}).\n\n` +
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
    db.from('tasks').select('id, code, name, end_date, deadline, notified_leader_id').is('completed_on', null),
    db.from('task_leaders').select('task_id, leader_id'),
    db.from('profiles').select(PROFILE_COLS),
  ]);
  const error = t.error || l.error || p.error;
  if (error) throw error;
  const leaderOf = new Map((l.data ?? []).map((x: any) => [x.task_id, x.leader_id]));
  const person = new Map<string, Profile>((p.data ?? []).map((x: Profile) => [x.id, x]));
  // Due date of a task: its deadline, or its planned end when no deadline is set
  return { tasks: (t.data ?? []).map((x: any) => ({ ...x, due: x.deadline ?? x.end_date, leader_id: leaderOf.get(x.id) ?? null })), person };
}

const taskLine = (t: any) => `- ${t.code} ${t.name} (${t.deadline ? 'deadline' : 'planned end'} ${isoDay(t.due)})`;

/* ---------- 3. task assignments: tasks gained and taken away ---------- */
// Once a day from 07:00 (planning sessions make many changes, often
// corrected): the current leader of each task is compared with the last one
// notified, so only the net changes of the day before are sent.
// The former leader learns which tasks now have another leader or none;
// one e-mail per person. Former leaders whose account is no longer active
// get no notice.
async function processAssignments() {
  if (Number(zoned(new Date()).hour) < DEADLINE_HOUR) return 0;
  const runKey = `assignments:${romeDate(new Date())}`;
  const { data: ran, error: e0 } = await db.from('notification_log').select('key').eq('key', runKey);
  if (e0) throw e0;
  if (ran?.length) return 0;
  const sent = await sendAssignments();
  await db.from('notification_log').insert({ key: runKey });
  return sent;
}

async function sendAssignments() {
  const { tasks, person } = await openTasksWithLeader();
  const changed = tasks.filter((t: any) => t.leader_id !== t.notified_leader_id);
  const byPerson = new Map<string, { gained: any[]; lost: any[] }>();
  const entry = (id: string) => {
    if (!byPerson.has(id)) byPerson.set(id, { gained: [], lost: [] });
    return byPerson.get(id)!;
  };
  for (const t of changed) {
    if (t.leader_id) entry(t.leader_id).gained.push(t);
    if (t.notified_leader_id) entry(t.notified_leader_id).lost.push(t);
  }
  const byDue = (a: any, b: any) => (a.due < b.due ? -1 : 1);
  const lostLine = (t: any) => `${taskLine(t)}, now ${t.leader_id ? `led by ${nameOf(person.get(t.leader_id))}` : 'without leader'}`;
  const one = (list: any[]) => `${list[0].code} ${list[0].name}`;
  let sent = 0;
  for (const [id, { gained, lost }] of byPerson) {
    const p = person.get(id);
    const lostShown = p?.status === 'active' ? lost : [];
    if (p?.email && (gained.length || lostShown.length)) {
      gained.sort(byDue);
      lostShown.sort(byDue);
      const subject = gained.length && lostShown.length ? 'Changes to the tasks assigned to you'
        : gained.length ? (gained.length === 1 ? `Task assigned to you: ${one(gained)}` : `${gained.length} tasks assigned to you`)
        : (lostShown.length === 1 ? `Task no longer assigned to you: ${one(lostShown)}` : `${lostShown.length} tasks no longer assigned to you`);
      const text = [
        gained.length ? `The following task${gained.length === 1 ? ' is' : 's are'} now assigned to you as leader:\n\n` +
          gained.map(taskLine).join('\n') : '',
        lostShown.length ? `The following task${lostShown.length === 1 ? ' is' : 's are'} no longer assigned to you:\n\n` +
          lostShown.map(lostLine).join('\n') : '',
      ].filter(Boolean).join('\n\n');
      sent += await send([p.email], subject, `${text}\n\nProject plan: ${SITE_URL}gantt.html`);
    }
    // Bookkeeping after the e-mail: tasks gained by this person, tasks left without leader
    for (const t of gained) await db.from('tasks').update({ notified_leader_id: t.leader_id }).eq('id', t.id);
    for (const t of lost.filter((x) => !x.leader_id)) await db.from('tasks').update({ notified_leader_id: null }).eq('id', t.id);
  }
  return sent;
}

/* ---------- 4. deadline notices ---------- */
async function processDeadlines() {
  if (Number(zoned(new Date()).hour) < DEADLINE_HOUR) return 0;
  const today = romeDate(new Date());
  const targets = new Map(DEADLINE_DAYS.map((n) => [addDays(today, n), n]));
  const { tasks, person } = await openTasksWithLeader();
  const due = tasks.filter((t: any) => t.leader_id && targets.has(t.due))
    .map((t: any) => ({ ...t, days: targets.get(t.due), key: `deadline:${targets.get(t.due)}:${t.id}:${t.due}:${t.leader_id}` }));
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

/* ---------- 5. overdue tasks ---------- */
// Once per task and due date, the day after the due date (only for due dates
// of the last OVERDUE_WINDOW days: no flood of old cases on activation).
// Leaders who are not admins: own tasks. Admins: all the tasks.
async function processOverdue() {
  if (Number(zoned(new Date()).hour) < DEADLINE_HOUR) return 0;
  const today = romeDate(new Date());
  const from = addDays(today, -OVERDUE_WINDOW);
  const { tasks, person } = await openTasksWithLeader();
  const late = tasks.filter((t: any) => t.due && t.due < today && t.due >= from)
    .map((t: any) => ({ ...t, key: `overdue:${t.id}:${t.due}` }));
  if (!late.length) return 0;
  const { data: done } = await db.from('notification_log').select('key').in('key', late.map((t: any) => t.key));
  const already = new Set((done ?? []).map((x: any) => x.key));
  const fresh = late.filter((t: any) => !already.has(t.key)).sort((a: any, b: any) => (a.due < b.due ? -1 : 1));
  if (!fresh.length) return 0;

  // Admins who want the summary; every other leader (admins included) gets the own tasks
  const admins = await adminsFor('tasks_overdue');
  const adminIds = new Set(admins.map((a) => a.id));
  const subject = (list: any[]) => (list.length === 1 ? `Task overdue: ${list[0].code} ${list[0].name}` : `${list.length} tasks overdue`);
  const intro = (list: any[]) => `The due date of the following task${list.length === 1 ? ' has' : 's have'} passed ` +
    `and the task${list.length === 1 ? ' is' : 's are'} not completed:\n\n`;
  const footer = 'If the work is done, enter the completion date; otherwise agree new dates with the admins.\n\n' +
    `Project plan: ${SITE_URL}gantt.html`;

  let sent = 0;
  const byLeader = new Map<string, any[]>();
  fresh.filter((t: any) => t.leader_id && !adminIds.has(t.leader_id)).forEach((t: any) => {
    if (!byLeader.has(t.leader_id)) byLeader.set(t.leader_id, []);
    byLeader.get(t.leader_id)!.push(t);
  });
  for (const [leaderId, list] of byLeader) {
    const leader = person.get(leaderId);
    if (!leader?.email) continue;
    sent += await send([leader.email], subject(list), `${intro(list)}${list.map(taskLine).join('\n')}\n\n${footer}`);
  }
  const line = (t: any) => `${taskLine(t)}, leader: ${t.leader_id ? nameOf(person.get(t.leader_id)) : 'none'}`;
  sent += await send(emailsOf(admins), subject(fresh), `${intro(fresh)}${fresh.map(line).join('\n')}\n\n${footer}`);
  await db.from('notification_log').insert(fresh.map((t: any) => ({ key: t.key })));
  return sent;
}

/* ---------- 6. documents due for a milestone ---------- */
// DOC_DUE_DAYS before the data package of an open milestone is due (or its
// review date when the data package has no date), for each requirement not
// yet fulfilled (no version sent to ESA, not waived, not ad hoc).
// Responsibles who are not document managers: own documents. Document
// managers: all the documents, also those without responsible.
async function processDocuments() {
  if (Number(zoned(new Date()).hour) < DEADLINE_HOUR) return 0;
  const today = romeDate(new Date());
  const targets = new Map(DOC_DUE_DAYS.map((n) => [addDays(today, n), n]));
  const { data: ms, error } = await db.from('milestones').select('id, code, name, docs_due, review_date, held_on').is('held_on', null);
  if (error) throw error;
  const due = new Map((ms ?? []).filter((m: any) => targets.has(msDue(m) ?? ''))
    .map((m: any) => [m.id, { ...m, due: msDue(m)!, days: targets.get(msDue(m)!)! }]));
  if (!due.size) return 0;

  const { data: reqs, error: e2 } = await db.from('document_requirements')
    .select('id, milestone_id, level, documents(id, subteam, doc_type, title, name, responsible_id, on_hold), ' +
      'tasks(code, end_date, deadline, completed_on)')
    .in('milestone_id', [...due.keys()]).eq('waived', false).is('version_id', null).neq('level', 'ad_hoc');
  if (e2) throw e2;
  const items = (reqs ?? []).filter((r: any) => r.documents).map((r: any) => {
    const m = due.get(r.milestone_id)!;
    return { ...r, m, key: `docdue:${m.days}:${r.id}:${m.due}` };
  });
  if (!items.length) return 0;
  const { data: done } = await db.from('notification_log').select('key').in('key', items.map((r: any) => r.key));
  const already = new Set((done ?? []).map((x: any) => x.key));
  const fresh = items.filter((r: any) => !already.has(r.key));
  if (!fresh.length) return 0;

  // Last version of each document
  const docIds = [...new Set(fresh.map((r: any) => r.documents.id))];
  const { data: vers, error: e3 } = await db.from('document_versions').select('document_id, version, status').in('document_id', docIds);
  if (e3) throw e3;
  const last = new Map<number, any>();
  (vers ?? []).forEach((v: any) => { if ((last.get(v.document_id)?.version ?? -1) < v.version) last.set(v.document_id, v); });

  const [managers, people] = await Promise.all([docManagers(), profilesById(fresh.map((r: any) => r.documents.responsible_id))]);
  const managerIds = new Set(managers.map((p) => p.id));
  const when = (days: number) => (days === 1 ? 'tomorrow' : `in ${days} days`);

  const line = (r: any, withResponsible: boolean) => {
    const d = r.documents;
    const v = last.get(d.id);
    const parts = [`required: ${LEVEL[r.level] ?? r.level}`,
      v ? `last version ${vv(v.version)} ${VERSION_STATUS[v.status] ?? v.status}` : 'no version yet'];
    if (d.on_hold) parts.push('ON HOLD');
    if (withResponsible) parts.push(`responsible: ${d.responsible_id ? nameOf(people.get(d.responsible_id)) : 'none'}`);
    if (r.tasks) {
      parts.push(r.tasks.completed_on ? `Gantt task ${r.tasks.code} completed`
        : `Gantt task ${r.tasks.code} due ${isoDay(r.tasks.deadline ?? r.tasks.end_date)}`);
    }
    return `- ${docBase(d)} (${d.name}): ${parts.join(', ')}\n  ${docLink(d.id)}`;
  };
  // Grouped by milestone, nearest first
  const body = (list: any[], withResponsible: boolean) => [...new Set(list.map((r) => r.m))]
    .sort((a: any, b: any) => a.days - b.days)
    .map((m: any) => `${m.code} ${m.name}: ${m.docs_due ? 'data package due' : 'review on'} ${isoDay(m.due)} (${when(m.days)})\n` +
      list.filter((r) => r.m === m).map((r) => line(r, withResponsible)).join('\n'))
    .join('\n\n');
  const subject = (list: any[]) => {
    const codes = [...new Set(list.map((r) => r.m.code))];
    const nearest = Math.min(...list.map((r) => r.m.days));
    return `Documents due for ${codes.join(', ')} ${when(nearest)}`;
  };
  const footer = 'A requirement is fulfilled when a version of the document is sent to ESA and linked to the milestone.\n\n' +
    `Documents: ${SITE_URL}documents.html`;

  let sent = 0;
  const byResponsible = new Map<string, any[]>();
  fresh.filter((r: any) => r.documents.responsible_id && !managerIds.has(r.documents.responsible_id)).forEach((r: any) => {
    const id = r.documents.responsible_id;
    if (!byResponsible.has(id)) byResponsible.set(id, []);
    byResponsible.get(id)!.push(r);
  });
  for (const [id, list] of byResponsible) {
    const p = people.get(id);
    if (!p?.email || p.status !== 'active') continue;
    sent += await send([p.email], subject(list),
      `The following documents you are responsible for are required and not delivered yet:\n\n${body(list, false)}\n\n${footer}`);
  }
  sent += await send(emailsOf(managers), subject(fresh),
    `The following documents are required and not delivered yet:\n\n${body(fresh, true)}\n\n${footer}`);
  await db.from('notification_log').insert(fresh.map((r: any) => ({ key: r.key })));
  return sent;
}

/* ---------- 7. registrations awaiting approval ---------- */
async function processRegistrations() {
  const { data: pending, error } = await db.rpc('pending_registrations');
  if (error) throw error;
  if (!pending?.length) return 0;
  const keys = pending.map((p: any) => `registration:${p.id}`);
  const { data: done } = await db.from('notification_log').select('key').in('key', keys);
  const already = new Set((done ?? []).map((x: any) => x.key));
  const fresh = pending.filter((p: any) => !already.has(`registration:${p.id}`));
  if (!fresh.length) return 0;
  const to = emailsOf(await adminsFor('registrations'));
  if (!to.length) return 0;
  await send(to, fresh.length === 1 ? 'New registration awaiting approval' : `${fresh.length} registrations awaiting approval`,
    `The following account${fresh.length === 1 ? ' is' : 's are'} awaiting approval:\n\n` +
    `${fresh.map((p: any) => `- ${p.full_name ?? '(name not entered yet)'} <${p.email}>`).join('\n')}\n\n` +
    `Approve or reject: ${SITE_URL}members.html`);
  await db.from('notification_log').insert(fresh.map((p: any) => ({ key: `registration:${p.id}` })));
  return 1;
}

/* ---------- 8. events queued by the database (migration 013) ---------- */
// Each handler reads the current data and sends nothing when the event is
// out of date (e.g. a request withdrawn before the e-mail was sent).
type Handler = (e: any, actor: string | null) => Promise<number>;

const ROLE_NAME: Record<string, string> = { user: 'User', teamleader: 'Teamleader', admin: 'Admin' };
const ROLE_TEXT: Record<string, string> = {
  user: 'you book lab hours as participant, request lab shifts, read the project plan and the documents.',
  teamleader: 'as a User, and you can also be leader of a department or of a task and responsible for documents.',
  admin: 'you manage project plan, lab shifts, documents and members, and you supervise the lab shifts.',
};
const roleLine = (role: string) => `Role: ${ROLE_NAME[role] ?? role} - ${ROLE_TEXT[role] ?? ''}`;

const onAccountStatus: Handler = async (e, actor) => {
  const p = (await profilesById([e.user_id])).get(e.user_id);
  if (!p || p.status !== e.to) return 0;
  const to = emailsOf([p], actor);
  if (e.to === 'active') {
    const again = e.from === 'disabled';
    return send(to, again ? 'Your account has been re-enabled' : 'Your account has been approved',
      `Your J2050 Team Management account is ${again ? 'active again' : 'now active'}.\n\n${roleLine(p.role)}\n\nLog in: ${SITE_URL}`);
  }
  if (e.to === 'disabled') {
    return e.from === 'pending'
      ? send(to, 'Your registration has not been approved',
        'Your registration to J2050 Team Management has not been approved.\n\nIf you think this is a mistake, contact an admin of the team.')
      : send(to, 'Your account has been disabled',
        'Your J2050 Team Management account has been disabled: you can no longer log in.\n\n' +
        'If you think this is a mistake, contact an admin of the team.');
  }
  return 0;
};

const onAccountRole: Handler = async (e, actor) => {
  const p = (await profilesById([e.user_id])).get(e.user_id);
  if (!p || p.status !== 'active' || p.role !== e.to) return 0;
  return send(emailsOf([p], actor), `Your role is now ${ROLE_NAME[e.to] ?? e.to}`,
    `Your role in J2050 Team Management has changed from ${ROLE_NAME[e.from] ?? e.from} to ${ROLE_NAME[e.to] ?? e.to}.\n\n` +
    `${roleLine(e.to)}\n\n${SITE_URL}`);
};

const onTeamLeader: Handler = async (e, actor) => {
  const people = await profilesById([e.from, e.to]);
  const next = e.to ? people.get(e.to) : null;
  const prev = e.from ? people.get(e.from) : null;
  let sent = 0;
  if (next) {
    sent += await send(emailsOf([next], actor), `You are now leader of the ${e.team} department`,
      `You have been named leader of the ${e.team} department.\n\n` +
      'The tasks of the department without a leader set on the task are now assigned to you: ' +
      'you receive their list in a separate e-mail.' +
      (e.team === 'SYS' ? '\n\nAs SYS leader you are also a document manager: you create, edit and delete every document ' +
        'and edit milestones and required documents.' : '') +
      `\n\nProject plan: ${SITE_URL}gantt.html`);
  }
  if (prev?.status === 'active') {
    sent += await send(emailsOf([prev], actor), `You are no longer leader of the ${e.team} department`,
      `You are no longer leader of the ${e.team} department. ` +
      `${next ? `The new leader is ${nameOf(next)}.` : 'The department has no leader at the moment.'}\n\n` +
      `Project plan: ${SITE_URL}gantt.html`);
  }
  return sent;
};

async function requestOf(id: number) {
  const { data, error } = await db.from('shift_requests')
    .select('id, requested_by, starts_at, ends_at, location, description, status, admin_note, decided_by, tasks(code, name)')
    .eq('id', id).maybeSingle();
  if (error) throw error;
  return data as any;
}
const requestText = (r: any) => [
  `When: ${fDay(r.starts_at)}, ${fTime(r.starts_at)}\u2013${fTime(r.ends_at)}`,
  `Task: ${r.tasks ? `${r.tasks.code} ${r.tasks.name}` : 'not specified'}`,
  r.description ? `Work to do: ${r.description}` : '',
  r.location ? `Location: ${r.location}` : '',
].filter(Boolean).join('\n');

const onShiftRequest: Handler = async (e, actor) => {
  const r = await requestOf(e.request_id);
  if (!r || r.status !== 'pending') return 0;
  const [admins, people] = await Promise.all([adminsFor('shift_requests'), profilesById([r.requested_by])]);
  const requester = people.get(r.requested_by);
  return send(emailsOf(admins.filter((a) => a.id !== r.requested_by), actor),
    `Shift request: ${nameOf(requester)}, ${fDay(r.starts_at)} ${fTime(r.starts_at)}\u2013${fTime(r.ends_at)}`,
    `${nameOf(requester)} requests a lab shift:\n\n${requestText(r)}\n\nApprove or reject: ${SITE_URL}shifts.html`);
};

const onRequestRejected: Handler = async (e, actor) => {
  const r = await requestOf(e.request_id);
  if (!r || r.status !== 'rejected') return 0;
  const people = await profilesById([r.requested_by, r.decided_by]);
  return send(emailsOf([people.get(r.requested_by)], actor),
    `Shift request rejected: ${fDay(r.starts_at)} ${fTime(r.starts_at)}\u2013${fTime(r.ends_at)}`,
    `Your lab shift request has been rejected${r.decided_by ? ` by ${nameOf(people.get(r.decided_by))}` : ''}.\n\n` +
    `${requestText(r)}\n\nReason: ${r.admin_note ?? 'not given'}\n\nLab shifts: ${SITE_URL}shifts.html`);
};

async function versionOf(id: number) {
  const { data, error } = await db.from('document_versions')
    .select('id, version, status, file_url, change_note, review_note, submitted_by, approved_by, ' +
      'documents(id, subteam, doc_type, title, name, responsible_id)')
    .eq('id', id).maybeSingle();
  if (error) throw error;
  return data as any;
}
const fileOf = (v: any) => `${docBase(v.documents)}_${vv(v.version)}`;

const onDocSubmitted: Handler = async (e, actor) => {
  const v = await versionOf(e.version_id);
  if (!v?.documents || v.status !== 'in_review') return 0;
  const [admins, people] = await Promise.all([adminsFor('doc_review'), profilesById([v.submitted_by, v.documents.responsible_id])]);
  return send(emailsOf(admins, actor), `For review: ${fileOf(v)}`,
    `${nameOf(people.get(v.submitted_by))} has sent a document version for review.\n\n` +
    `Document: ${fileOf(v)} (${v.documents.name})\n` +
    `Responsible: ${nameOf(people.get(v.documents.responsible_id))}\n` +
    `PDF: ${v.file_url ?? 'no link'}\n` +
    `${v.change_note ? `Changes: ${v.change_note}\n` : ''}` +
    `\nApprove or return it: ${docLink(v.documents.id)}`);
};

const onDocApproved: Handler = async (e, actor) => {
  const v = await versionOf(e.version_id);
  if (!v?.documents || ['in_progress', 'in_review'].includes(v.status)) return 0;
  const people = await profilesById([v.documents.responsible_id, v.submitted_by, v.approved_by]);
  return send(emailsOf([people.get(v.documents.responsible_id), people.get(v.submitted_by)], actor),
    `Approved: ${fileOf(v)}`,
    `${fileOf(v)} (${v.documents.name}) has been approved${v.approved_by ? ` by ${nameOf(people.get(v.approved_by))}` : ''}.\n\n` +
    'The approved PDF is now frozen: further changes go in the next version. ' +
    'When the version is sent to ESA, enter the date and the ESA link on the document page.\n\n' +
    `Document: ${docLink(v.documents.id)}`);
};

const onDocReturned: Handler = async (e, actor) => {
  const v = await versionOf(e.version_id);
  if (!v?.documents || v.status !== 'in_progress' || !v.review_note) return 0;
  const people = await profilesById([v.documents.responsible_id, v.submitted_by, actor]);
  return send(emailsOf([people.get(v.documents.responsible_id), people.get(v.submitted_by)], actor),
    `Returned: ${fileOf(v)}`,
    `${fileOf(v)} (${v.documents.name}) has been returned${actor ? ` by ${nameOf(people.get(actor))}` : ''} ` +
    `with the following note:\n\n${v.review_note}\n\n` +
    `Update the version and send it for review again: ${docLink(v.documents.id)}`);
};

const onDocResponsible: Handler = async (e, actor) => {
  const { data: d, error } = await db.from('documents')
    .select('id, subteam, doc_type, title, name, responsible_id, ' +
      'document_requirements(level, waived, version_id, milestones(code, name, docs_due, review_date, held_on))')
    .eq('id', e.document_id).maybeSingle();
  if (error) throw error;
  const doc = d as any;
  if (!e.to || !doc || doc.responsible_id !== e.to) return 0;
  const people = await profilesById([doc.responsible_id, actor]);
  const open = (doc.document_requirements ?? [])
    .filter((r: any) => !r.waived && !r.version_id && r.milestones && !r.milestones.held_on)
    .map((r: any) => ({ ...r, due: msDue(r.milestones) }))
    .sort((a: any, b: any) => (a.due ?? '9999') < (b.due ?? '9999') ? -1 : 1);
  const lines = open.map((r: any) => `- ${r.milestones.code} ${r.milestones.name}: ${LEVEL[r.level] ?? r.level}` +
    `${r.due ? `, due ${isoDay(r.due)}` : ''}`);
  return send(emailsOf([people.get(doc.responsible_id)], actor), `Document assigned to you: ${docBase(doc)}`,
    `You are now responsible for the document ${docBase(doc)} (${doc.name})` +
    `${actor ? `, assigned by ${nameOf(people.get(actor))}` : ''}.\n\n` +
    `${lines.length ? `Required at:\n${lines.join('\n')}` : 'It is not required at any open milestone.'}\n\n` +
    `Document: ${docLink(doc.id)}`);
};

const HANDLERS: Record<string, Handler> = {
  account_status: onAccountStatus,
  account_role: onAccountRole,
  team_leader: onTeamLeader,
  shift_request: onShiftRequest,
  request_rejected: onRequestRejected,
  doc_submitted: onDocSubmitted,
  doc_approved: onDocApproved,
  doc_returned: onDocReturned,
  doc_responsible: onDocResponsible,
};

// Events of the same kind and object form a group (e.g. all the changes of
// the responsible of one document). A group is handled when its last event
// is QUIET_MINUTES old: one e-mail for the net change, from the state
// before the first event to the state after the last one (actor: the last).
// Kinds with "from"/"to": no e-mail when the two are equal (A -> B -> A).
// A group that fails is retried at the next runs, then left aside
// (attempts = MAX_ATTEMPTS, error kept) without blocking the others.
const NET_KINDS = new Set(['account_status', 'account_role', 'team_leader', 'doc_responsible']);
const eventObject = (ev: any) => {
  const p = ev.payload ?? {};
  return `${ev.kind}:${p.user_id ?? p.team ?? p.request_id ?? p.version_id ?? p.document_id ?? `event-${ev.id}`}`;
};

async function processEvents() {
  const { data: events, error } = await db.from('notification_queue').select('*')
    .lt('attempts', MAX_ATTEMPTS).order('id').limit(500);
  if (error) throw error;
  const groups = new Map<string, any[]>();
  for (const ev of events ?? []) {
    const k = eventObject(ev);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(ev);
  }
  const quiet = Date.now() - QUIET_MINUTES * 60e3;
  const ready = [...groups.values()].filter((g) => Date.parse(g[g.length - 1].created_at) <= quiet).slice(0, EVENT_BATCH);
  // Account approved and role set together: the approval e-mail already gives the role
  const approved = new Set(ready.filter((g) => g[0].kind === 'account_status' && g[g.length - 1].payload?.to === 'active')
    .map((g) => g[0].payload?.user_id));

  let sent = 0;
  for (const g of ready) {
    const first = g[0];
    const last = g[g.length - 1];
    const ids = g.map((ev) => ev.id);
    const e = { ...(last.payload ?? {}), from: first.payload?.from ?? null };
    try {
      const unchanged = NET_KINDS.has(first.kind) && (e.from ?? null) === (e.to ?? null);
      const covered = first.kind === 'account_role' && approved.has(e.user_id);
      const handler = HANDLERS[first.kind];
      if (handler && !unchanged && !covered) sent += await handler(e, last.actor_id);
      await db.from('notification_queue').delete().in('id', ids);
    } catch (err) {
      console.error('events', ids, first.kind, err);
      await db.from('notification_queue')
        .update({ attempts: Math.max(...g.map((ev) => ev.attempts)) + 1, last_error: String((err as Error)?.message ?? err).slice(0, 500) })
        .in('id', ids);
    }
  }
  return sent;
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
      await send([String(body.to)], 'J2050 Team Management \u2013 test', 'Test message: the notification service can send e-mails.');
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
    report.events = await step(processEvents);
    report.leaders = await step(processAssignments);
    report.deadlines = await step(processDeadlines);
    report.overdue = await step(processOverdue);
    report.documents = await step(processDocuments);
    report.members = await step(processRegistrations);
  } finally {
    await db.rpc('release_notify_lease');
  }
  return json(report);
});
