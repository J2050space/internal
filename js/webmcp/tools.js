// WebMCP tool definitions (read-only, phase 1).
// registerTools() is pure: it only needs the model context and a data adapter,
// which keeps it testable without Supabase (see tests/webmcp.html).
import { WEEKDAYS } from './model.js';

export const DEPARTMENTS = ['SYS', 'ELE', 'SFW', 'AOCS', 'THM', 'TTC', 'OUT', 'MGT'];
const TASK_STATUSES = ['planned', 'progress', 'overdue', 'late_start', 'done', 'at_risk', 'blocked'];

const text = (value, name, max = 120) => {
  if (value == null) return '';
  if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
  const out = value.trim();
  if (out.length > max) throw new Error(`${name} must be at most ${max} characters.`);
  return out;
};

const integer = (value, name, min, max, fallback) => {
  if (value == null) return fallback;
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer.`);
  if (value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}.`);
  return value;
};

const oneOf = (value, allowed, name) => {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  const match = allowed.find((entry) => entry.toLowerCase() === raw.toLowerCase());
  if (!match) throw new Error(`${name} must be one of: ${allowed.join(', ')}.`);
  return match;
};

function tool({ name, title, description, inputSchema, untrusted = false, run }) {
  return {
    name,
    title,
    description,
    inputSchema,
    annotations: { readOnlyHint: true, ...(untrusted ? { untrustedContentHint: true } : {}) },
    execute: async (input = {}) => {
      try {
        return JSON.stringify(await run(input ?? {}));
      } catch (error) {
        console.error(`WebMCP tool ${name} failed`, error);
        return JSON.stringify({ error: error?.message ?? String(error) });
      }
    },
  };
}

function coreTools(data) {
  return [
    tool({
      name: 'search_tasks',
      title: 'Search project tasks',
      description: 'Search the J2050 project plan by free text, department or status. '
        + 'Returns task code, name, planned dates, deadline, derived status, leader and risk flags. '
        + 'Read-only. Completed tasks are excluded unless status is "done" or include_done is true.',
      untrusted: true,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text matched against code, name, people and leader name.' },
          department: { type: 'string', enum: DEPARTMENTS, description: 'Department code.' },
          status: { type: 'string', enum: TASK_STATUSES, description: 'Derived status filter.' },
          include_done: { type: 'boolean', description: 'Include completed tasks when no status is given.' },
          limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum tasks returned. Default 10.' },
        },
      },
      run: (input) => {
        const args = {
          query: text(input.query, 'query'),
          department: oneOf(input.department, DEPARTMENTS, 'department'),
          status: oneOf(input.status, TASK_STATUSES, 'status'),
          include_done: Boolean(input.include_done),
          limit: integer(input.limit, 'limit', 1, 20, 10),
        };
        return data.searchTasks(args);
      },
    }),
    tool({
      name: 'task_details',
      title: 'Task details',
      description: 'Full details of a single task by code (for example ELE-01 or ELE-01.2): '
        + 'dates, status, margin, blocked reason, leader, subtasks and dependencies. Read-only.',
      untrusted: true,
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Task code, for example ELE-01.' },
        },
        required: ['code'],
      },
      run: (input) => data.taskDetails({ code: text(input.code, 'code', 32) }),
    }),
    tool({
      name: 'upcoming_deadlines',
      title: 'Upcoming deadlines',
      description: 'Tasks with a deadline in the next N days, including overdue tasks. '
        + 'Each task reports days_left (negative when overdue). Read-only.',
      untrusted: true,
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'integer', minimum: 1, maximum: 90, description: 'Horizon in days. Default 14.' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum tasks returned. Default 20.' },
        },
      },
      run: (input) => data.upcomingDeadlines({
        days: integer(input.days, 'days', 1, 90, 14),
        limit: integer(input.limit, 'limit', 1, 50, 20),
      }),
    }),
  ];
}

function shiftTools(data) {
  return [
    tool({
      name: 'list_free_slots',
      title: 'Free lab slots',
      description: 'Free half-hour slots in the J2050 laboratory (Monday to Friday, 08:30-18:30), '
        + 'for the current week or one of the next three. Returns contiguous ranges with free seats, '
        + 'supervisor coverage, shift id and task. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          week_offset: { type: 'integer', minimum: 0, maximum: 3, description: '0 = current week, 1 = next week. Default 0.' },
          weekday: { type: 'string', enum: WEEKDAYS, description: 'Only this weekday.' },
          min_minutes: { type: 'integer', minimum: 30, maximum: 480, description: 'Minimum length of a range, multiple of 30. Default 30.' },
        },
      },
      run: (input) => {
        const minMinutes = integer(input.min_minutes, 'min_minutes', 30, 480, 30);
        if (minMinutes % 30 !== 0) throw new Error('min_minutes must be a multiple of 30.');
        return data.listFreeSlots({
          week_offset: integer(input.week_offset, 'week_offset', 0, 3, 0),
          weekday: oneOf(input.weekday, WEEKDAYS, 'weekday'),
          min_minutes: minMinutes,
        });
      },
    }),
    tool({
      name: 'my_bookings',
      title: 'My lab bookings',
      description: 'The signed-in user\'s lab shift bookings, with date, time, role, task and location. '
        + 'Past bookings are excluded unless include_past is true. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          include_past: { type: 'boolean', description: 'Include bookings of ended shifts.' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum bookings returned. Default 20.' },
        },
      },
      run: (input) => data.myBookings({
        include_past: Boolean(input.include_past),
        limit: integer(input.limit, 'limit', 1, 50, 20),
      }),
    }),
  ];
}

// Registers the core tools on every protected page and the shift tools on
// shifts.html. Passing the registration AbortSignal unregisters them on abort.
export async function registerTools(ctx, { profile, page, data }, { signal } = {}) {
  if (!ctx) throw new Error('WebMCP: model context not available.');
  if (!profile) throw new Error('WebMCP: no signed-in profile.');
  const tools = [...coreTools(data), ...(page === 'shifts' ? shiftTools(data) : [])];
  await Promise.all(tools.map((entry) => ctx.registerTool(entry, signal ? { signal } : undefined)));
  return tools.map((entry) => entry.name);
}
