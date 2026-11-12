// Read-only data access for the WebMCP tools.
// The tools never scrape the DOM: they read the same tables and views as the
// pages, with the signed-in user's session, so Row Level Security stays the
// only source of truth for permissions.
import { supabase } from '../config.js';
import { todayIso, zonedParts, zonedToIso } from '../format.js';
import {
  WEEKDAYS, dayNumber, freeRanges, isoDate, mondayOf, statusOf, weekdayIndex,
} from './model.js';

const SNAPSHOT_TTL_MS = 30_000;
const hhmm = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const TASK_FIELDS = 'id, code, name, department, teams, parent_id, start_date, end_date, '
  + 'deadline, started_on, completed_on, blocked, blocked_reason, leader_id, people, '
  + 'note, milestone_label, updated_at';

function taskView(task, snapshot, today) {
  const leaderId = snapshot.leaders.get(task.id)?.leader_id ?? null;
  return {
    code: task.code,
    name: task.name,
    department: task.department,
    teams: task.teams ?? [],
    parent: task.parent_id ? snapshot.codeOf(task.parent_id) : null,
    start: task.start_date,
    end: task.end_date,
    deadline: task.deadline,
    status: statusOf(task, today),
    blocked: task.blocked ? (task.blocked_reason || 'blocked') : null,
    at_risk: Boolean(!task.completed_on && task.deadline
      && (task.end_date > task.deadline || today > task.deadline)),
    margin_days: task.deadline ? dayNumber(task.deadline) - dayNumber(task.end_date) : null,
    started_on: task.started_on,
    completed_on: task.completed_on,
    leader: leaderId ? (snapshot.people.get(leaderId) ?? null) : null,
    leader_source: snapshot.leaders.get(task.id)?.source ?? null,
    people: task.people ?? null,
    milestone: task.milestone_label ?? null,
    note: task.note ?? null,
    has_subtasks: (snapshot.children.get(task.id) ?? []).length > 0,
  };
}

function brief(view) {
  const { note, ...rest } = view;
  return rest;
}

export function createData(client = supabase, { profile } = {}) {
  const me = profile?.id ?? null;
  let cache = null;

  // Tasks, dependencies, effective leaders and names, cached for a few seconds.
  async function snapshot() {
    if (cache && Date.now() - cache.at < SNAPSHOT_TTL_MS) return cache.value;
    const [tasks, deps, leaders, people] = await Promise.all([
      client.from('tasks').select(TASK_FIELDS),
      client.from('task_dependencies').select('task_id, depends_on'),
      client.from('task_leaders').select('task_id, leader_id, source'),
      client.from('profiles').select('id, full_name, email'),
    ]);
    const error = tasks.error || deps.error || leaders.error || people.error;
    if (error) throw error;

    const byId = new Map(tasks.data.map((t) => [t.id, t]));
    const children = new Map();
    for (const task of tasks.data) {
      if (!task.parent_id) continue;
      if (!children.has(task.parent_id)) children.set(task.parent_id, []);
      children.get(task.parent_id).push(task);
    }
    const dependsOn = new Map();
    const requiredBy = new Map();
    for (const edge of deps.data) {
      if (!dependsOn.has(edge.task_id)) dependsOn.set(edge.task_id, []);
      dependsOn.get(edge.task_id).push(edge.depends_on);
      if (!requiredBy.has(edge.depends_on)) requiredBy.set(edge.depends_on, []);
      requiredBy.get(edge.depends_on).push(edge.task_id);
    }
    const value = {
      tasks: tasks.data,
      byId,
      codeOf: (id) => byId.get(id)?.code ?? null,
      people: new Map(people.data.map((p) => [p.id, p.full_name ?? p.email])),
      leaders: new Map(leaders.data.map((l) => [l.task_id, l])),
      children,
      dependsOn,
      requiredBy,
    };
    cache = { at: Date.now(), value };
    return value;
  }

  async function searchTasks({ query, department, status, include_done: includeDone, limit }) {
    const today = todayIso();
    const snapshotValue = await snapshot();
    const text = String(query ?? '').trim().toLowerCase();
    const rows = [];
    for (const task of snapshotValue.tasks) {
      const view = taskView(task, snapshotValue, today);
      if (status === 'at_risk') {
        if (!view.at_risk) continue;
      } else if (status === 'blocked') {
        if (!view.blocked) continue;
      } else if (status) {
        if (view.status !== status) continue;
      } else if (!includeDone && view.status === 'done') {
        continue;
      }
      if (department && task.department !== department && !(task.teams ?? []).includes(department)) {
        continue;
      }
      if (text) {
        const haystack = `${task.code} ${task.name} ${task.people ?? ''} ${view.leader ?? ''}`.toLowerCase();
        if (!haystack.includes(text)) continue;
      }
      rows.push(brief(view));
    }
    rows.sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
    return {
      count: rows.length,
      shown: Math.min(rows.length, limit),
      tasks: rows.slice(0, limit),
    };
  }

  async function taskDetails({ code }) {
    const snapshotValue = await snapshot();
    const wanted = String(code ?? '').trim().toLowerCase();
    const task = snapshotValue.tasks.find((t) => t.code.toLowerCase() === wanted);
    if (!task) return { error: `Task ${code} not found.` };
    const today = todayIso();
    const byCode = (a, b) => a.code.localeCompare(b.code, 'en', { numeric: true });
    return {
      task: taskView(task, snapshotValue, today),
      subtasks: (snapshotValue.children.get(task.id) ?? [])
        .map((child) => taskView(child, snapshotValue, today)).sort(byCode),
      depends_on: (snapshotValue.dependsOn.get(task.id) ?? [])
        .map(snapshotValue.codeOf).filter(Boolean).sort(),
      required_by: (snapshotValue.requiredBy.get(task.id) ?? [])
        .map(snapshotValue.codeOf).filter(Boolean).sort(),
    };
  }

  async function upcomingDeadlines({ days, limit }) {
    const today = todayIso();
    const snapshotValue = await snapshot();
    const horizon = isoDate(dayNumber(today) + days);
    const rows = snapshotValue.tasks
      .filter((t) => t.deadline && !t.completed_on && t.deadline <= horizon)
      .map((t) => ({ ...brief(taskView(t, snapshotValue, today)), days_left: dayNumber(t.deadline) - dayNumber(today) }))
      .sort((a, b) => a.deadline.localeCompare(b.deadline)
        || a.code.localeCompare(b.code, 'en', { numeric: true }));
    return { today, horizon, count: rows.length, tasks: rows.slice(0, limit) };
  }

  async function shiftsOfWeek(monday) {
    const to = isoDate(dayNumber(monday) + 7);
    const { data, error } = await client.from('shifts')
      .select('id, starts_at, ends_at, capacity, location, tasks(code, name), '
        + 'assignments(user_id, role, starts_at, ends_at)')
      .gte('starts_at', zonedToIso(monday, '00:00'))
      .lt('starts_at', zonedToIso(to, '00:00'))
      .order('starts_at');
    if (error) throw error;
    return data;
  }

  async function listFreeSlots({ week_offset: weekOffset, weekday, min_minutes: minMinutes }) {
    const today = todayIso();
    const monday = isoDate(dayNumber(mondayOf(today)) + weekOffset * 7);
    const shifts = await shiftsOfWeek(monday);
    const slots = [];
    for (const shift of shifts) {
      const date = zonedParts(shift.starts_at).date;
      const dayName = WEEKDAYS[weekdayIndex(date)];
      if (weekday && weekday !== dayName) continue;
      for (const range of freeRanges(shift)) {
        const minutes = (range.end - range.start) / 60e3;
        if (minutes < minMinutes) continue;
        slots.push({
          date,
          weekday: dayName,
          start: range.startLabel,
          end: range.endLabel,
          minutes,
          seats: range.seats,
          supervisor: range.covered,
          shift_id: shift.id,
          task: shift.tasks?.code ?? null,
          task_name: shift.tasks?.name ?? null,
        });
      }
    }
    slots.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
    return {
      week_start: monday,
      week_end: isoDate(dayNumber(monday) + 4),
      count: slots.length,
      slots: slots.slice(0, 60),
    };
  }

  async function myBookings({ include_past: includePast, limit }) {
    if (!me) return { count: 0, bookings: [] };
    const { data, error } = await client.from('assignments')
      .select('shift_id, role, starts_at, ends_at, shifts(starts_at, ends_at, location, tasks(code, name))')
      .eq('user_id', me)
      .order('starts_at');
    if (error) throw error;
    const now = Date.now();
    const rows = data
      .filter((row) => row.shifts && (includePast || Date.parse(row.shifts.ends_at) >= now))
      .map((row) => {
        const shift = row.shifts;
        const date = zonedParts(shift.starts_at).date;
        return {
          date,
          weekday: WEEKDAYS[weekdayIndex(date)] ?? null,
          start: hhmm(zonedParts(row.starts_at).minutes),
          end: hhmm(zonedParts(row.ends_at).minutes),
          role: row.role,
          task: shift.tasks?.code ?? null,
          task_name: shift.tasks?.name ?? null,
          location: shift.location ?? null,
          shift_id: row.shift_id,
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
    return { count: rows.length, bookings: rows.slice(0, limit) };
  }

  return { searchTasks, taskDetails, upcomingDeadlines, listFreeSlots, myBookings };
}
