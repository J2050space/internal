// Project Gantt: views Gantt, Table, Sub-teams, This week, Timeline events.
// Data in Supabase (tables tasks, task_dependencies). Editing reserved to admins (RLS):
//   * task editor (create, edit, duplicate, delete; subtasks; dependencies; history)
//   * drag of the Gantt bars (move, change start or deadline)
//   * inline editing in the Table view
// Every save is checked against concurrent changes (tasks.updated_at).
import { supabase } from './config.js';
import { initProtectedPage, friendlyError } from './auth.js';
import { formatDate, TIME_ZONE } from './format.js';

/* ---------- constants ---------- */
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const STATUS = [
  ['todo', 'To do'], ['working', 'In progress'], ['done', 'Done'],
  ['late', 'Delayed'], ['qm_risk', 'QM at risk'], ['long_term', 'Long term'],
];
const STATUS_LABEL = Object.fromEntries(STATUS);
const TEAMS = ['SYSTEMS', 'ELECTRONICS', 'SOFTWARE', 'AOCS', 'TERMOMECH', 'TELECOM', 'OUTREACH', 'BOARD-PM'];
const VIEWS = [['gantt', 'Gantt'], ['table', 'Table'], ['teams', 'Sub-teams'], ['week', 'This week'], ['events', 'Timeline events']];
const DEFAULT_DURATION = 5;
const ZOOMS = [3, 5, 7, 10, 14];   // pixels per day in the Gantt
const CODE_RE = /^[A-Za-z0-9._-]{1,20}$/;

/* ---------- utilities ---------- */
const dn = (i) => { const p = i.split('-').map(Number); return Math.round(Date.UTC(p[0], p[1] - 1, p[2]) / 864e5); };
const iso = (n) => new Date(n * 864e5).toISOString().slice(0, 10);
const fmtS = (i) => { const p = i.split('-').map(Number); return `${p[2]} ${MON[p[1] - 1]}`; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date()); // YYYY-MM-DD
const TN = dn(TODAY);

function toast(message) {
  const t = document.getElementById('toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toast.h);
  toast.h = setTimeout(() => { t.hidden = true; }, 5000);
}

function download(name, text, type) {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

const ERRORS = {
  'Task modified by someone else': 'The task has been modified by someone else in the meantime: reload and repeat the change.',
  'Task not found': 'The task no longer exists: reload the page.',
  'Not authorized': 'Operation reserved to administrators.',
  'Dependency would create a cycle': 'This dependency would create a loop between tasks.',
  'Subtasks cannot have subtasks': 'A subtask cannot contain other subtasks.',
  'A task with subtasks cannot become a subtask': 'A task with subtasks cannot become a subtask.',
  'A task cannot be its own parent': 'A task cannot be its own parent.',
};
function errorText(error) {
  const m = error?.message ?? String(error);
  if (/tasks_code_unique/.test(m)) return 'Code already used by another task.';
  if (/tasks_check/.test(m)) return 'The deadline cannot precede the start date.';
  if (/foreign key/.test(m) && /shifts/.test(m)) return 'The task has lab shifts: delete or move them first.';
  return ERRORS[m] ?? friendlyError(error);
}

/* ---------- state ---------- */
const profile = await initProtectedPage('gantt');
const ADMIN = profile?.role === 'admin';
let ROWS = [];   // tasks from the database
let DEPS = [];   // { task_id, depends_on }
let EVENTS = []; // timeline events: fixed external dates, not tasks
let PEOPLE = new Map();  // profile id -> { name, role, status }
let TEAM_LEADERS = new Map(); // sub-team -> leader id
let ALL = [];    // derived, ordered
const stored = (key, fallback) => { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } };
const store = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } };
const ui = {
  view: 'gantt', gteam: 'All', team: 'SYSTEMS', q: '', hideDone: false, open: null, confirmDel: null,
  px: ZOOMS.includes(stored('gantt-px', 7)) ? stored('gantt-px', 7) : 7,
  collapsed: new Set(stored('gantt-collapsed', [])),
};

async function load() {
  const [t, d, ev, pr, tl] = await Promise.all([
    supabase.from('tasks').select('*'),
    supabase.from('task_dependencies').select('task_id, depends_on'),
    supabase.from('timeline_events').select('*'),
    supabase.from('profiles').select('id, full_name, email, role, status'),
    supabase.from('team_leaders').select('team, leader_id'),
  ]);
  if (t.error || d.error || ev.error || pr.error || tl.error) throw (t.error || d.error || ev.error || pr.error || tl.error);
  PEOPLE = new Map(pr.data.map((p) => [p.id, { name: p.full_name ?? p.email, role: p.role, status: p.status }]));
  TEAM_LEADERS = new Map(tl.data.map((x) => [x.team, x.leader_id]));
  ROWS = t.data;
  DEPS = d.data;
  EVENTS = ev.data.sort((a, b) => (a.event_date < b.event_date ? -1 : 1));
}

async function reload(message) {
  try { await load(); } catch (err) { toast(errorText(err)); return; }
  render();
  if (message) toast(message);
}

/* ---------- leaders ---------- */
// Same rule as the database view task_leaders:
// override > first sub-team of the task with a leader > leader of the parent task.
const validLeader = (id) => {
  const p = id ? PEOPLE.get(id) : null;
  return p && p.status === 'active' && (p.role === 'teamleader' || p.role === 'admin') ? id : null;
};
const teamLeader = (t) => {
  for (const team of TEAMS) if (t.teams.includes(team)) { const l = validLeader(TEAM_LEADERS.get(team)); if (l) return l; }
  return null;
};
const eligibleLeaders = () => [...PEOPLE.entries()]
  .filter(([id]) => validLeader(id))
  .sort((a, b) => a[1].name.localeCompare(b[1].name));
const nameOfPerson = (id) => (id ? PEOPLE.get(id)?.name ?? '?' : '');

/* ---------- derived model ---------- */
function cmp(a, b) {
  return a.end_date < b.end_date ? -1 : a.end_date > b.end_date ? 1
    : a.code.localeCompare(b.code, 'en', { numeric: true });
}

function build() {
  const byId = new Map(ROWS.map((r) => [r.id, r]));
  const requiredBy = new Map();   // id -> ids of tasks that depend on it
  const dependsOn = new Map();    // id -> ids it depends on
  DEPS.forEach(({ task_id: t, depends_on: d }) => {
    if (!requiredBy.has(d)) requiredBy.set(d, []);
    requiredBy.get(d).push(t);
    if (!dependsOn.has(t)) dependsOn.set(t, []);
    dependsOn.get(t).push(d);
  });

  const derived = ROWS.map((r) => {
    const t = { ...r };
    t.ls = iso(dn(t.end_date) - t.duration_days);
    t.late = t.status !== 'done' && t.end_date < TODAY;
    t.over = t.status !== 'done' && dn(t.start_date) > dn(t.ls);
    t.cls = t.status === 'done' ? 'done' : t.late ? 'late' : t.status;
    t.requiredBy = (requiredBy.get(t.id) ?? []).map((id) => byId.get(id)?.code).filter(Boolean).sort();
    t.requiredByIds = requiredBy.get(t.id) ?? [];
    t.dependsOnIds = dependsOn.get(t.id) ?? [];
    t.parentCode = t.parent_id ? byId.get(t.parent_id)?.code : null;
    return t;
  });

  // Effective leader
  const own = new Map(derived.map((t) => [t.id, validLeader(t.leader_id) ?? teamLeader(t)]));
  derived.forEach((t) => {
    const override = validLeader(t.leader_id);
    const team = teamLeader(t);
    const parent = t.parent_id ? own.get(t.parent_id) ?? null : null;
    t.defaultLeader = team ?? parent;
    t.defaultSource = team ? 'sub-team' : parent ? 'parent task' : null;
    t.leader = override ?? t.defaultLeader;
    t.leaderName = nameOfPerson(t.leader);
    t.invalidOverride = Boolean(t.leader_id && !override);
  });

  // Order: top-level tasks by deadline, each followed by its subtasks
  const children = new Map();
  derived.forEach((t) => {
    if (t.parent_id && byId.has(t.parent_id)) {
      if (!children.has(t.parent_id)) children.set(t.parent_id, []);
      children.get(t.parent_id).push(t);
    }
  });
  const out = [];
  derived.filter((t) => !t.parent_id || !byId.has(t.parent_id)).sort(cmp).forEach((p) => {
    p.depth = 0;
    p.hasChildren = children.has(p.id);
    out.push(p);
    (children.get(p.id) ?? []).sort(cmp).forEach((c) => { c.depth = 1; c.hasChildren = false; out.push(c); });
  });
  return out;
}

function filterTasks(list, team, q, hideDone) {
  return list.filter((t) => {
    if (team !== 'All' && !t.teams.includes(team)) return false;
    if (hideDone && t.status === 'done') return false;
    if (q) {
      const s = `${t.code} ${t.name} ${t.responsible ?? ''} ${t.leaderName}`.toLowerCase();
      if (!s.includes(q.toLowerCase())) return false;
    }
    return true;
  });
}

/* ---------- write operations (admin) ---------- */
async function patchTask(id, fields) {
  if (!ADMIN) return;
  const row = ROWS.find((r) => r.id === id);
  const { data, error } = await supabase.from('tasks').update(fields)
    .eq('id', id).eq('updated_at', row.updated_at).select().maybeSingle();
  if (error) { toast(errorText(error)); render(); return; }
  if (!data) { await reload(); toast(ERRORS['Task modified by someone else']); return; }
  ROWS = ROWS.map((r) => (r.id === id ? data : r));
  render();
}

async function addTask(fields) {
  const { error } = await supabase.from('tasks').insert(fields);
  if (error) { toast(errorText(error)); return; }
  await reload('Task added.');
}

async function deleteTask(id) {
  const { error } = await supabase.from('tasks').delete().eq('id', id);
  ui.confirmDel = null;
  if (error) { toast(errorText(error)); render(); return; }
  await reload('Task deleted.');
}

// "Required by": the task with id `succId` depends on `id`
async function setRequiredBy(id, succId, checked) {
  const q = checked
    ? supabase.from('task_dependencies').insert({ task_id: succId, depends_on: id })
    : supabase.from('task_dependencies').delete().eq('task_id', succId).eq('depends_on', id);
  const { error } = await q;
  if (error) toast(errorText(error));
  await reload();
}

/* ---------- common pieces ---------- */
function statusSelect(t) {
  return `<select data-id="${t.id}" data-f="status" aria-label="Status ${esc(t.code)}"${ADMIN ? '' : ' disabled'}>` +
    STATUS.map(([k, l]) => `<option value="${k}"${k === t.status ? ' selected' : ''}>${l}</option>`).join('') +
    '</select>';
}
const reqText = (t) => (t.requiredBy.length ? `Required by ${t.requiredBy.join(', ')}` : '');

function stats(ts) {
  const done = ts.filter((t) => t.status === 'done').length;
  const work = ts.filter((t) => t.status === 'working' && !t.late).length;
  const late = ts.filter((t) => t.late).length;
  const over = ts.filter((t) => t.over && !t.late).length;
  const noLeader = ts.filter((t) => t.status !== 'done' && !t.leader).length;
  let h = `<li>Done<b>${done}/${ts.length}</b></li><li>In progress<b>${work}</b></li>` +
    `<li>Open without leader<b class="${noLeader ? 'bad' : ''}">${noLeader}</b></li>` +
    `<li>Overdue<b class="${late ? 'bad' : ''}">${late}</b></li>` +
    `<li>Start after latest start<b class="${over ? 'bad' : ''}">${over}</b></li>`;
  ts.filter((t) => t.milestone_label).sort(cmp).forEach((m) => {
    h += `<li>Days to ${esc(m.milestone_label.toLowerCase())}<b>${dn(m.end_date) - TN}</b></li>`;
  });
  document.getElementById('stats').innerHTML = h;
}

function toolbar(withTeam) {
  const team = withTeam
    ? `<label>Sub-team <select id="gteam">${['All', ...TEAMS].map((k) =>
      `<option${k === ui.gteam ? ' selected' : ''}>${k}</option>`).join('')}</select></label>`
    : '';
  const zoom = withTeam ? `<span class="zoom" role="group" aria-label="Zoom">
      <button type="button" class="secondary" data-act="zoom-out" title="Zoom out"${ui.px === ZOOMS[0] ? ' disabled' : ''}>−</button>
      <button type="button" class="secondary" data-act="zoom-in" title="Zoom in"${ui.px === ZOOMS[ZOOMS.length - 1] ? ' disabled' : ''}>+</button></span>
    <button type="button" class="secondary" data-act="expand-all">Expand all</button>
    <button type="button" class="secondary" data-act="collapse-all">Collapse all</button>` : '';
  return `<div class="bar-tools">${ADMIN ? '<button type="button" data-act="new-task">New task</button>' : ''}${team}${zoom}
    <input id="q" type="search" placeholder="Search task or person" value="${esc(ui.q)}" aria-label="Search">
    <label class="chk"><input type="checkbox" id="hd"${ui.hideDone ? ' checked' : ''}> Hide done</label>
    <button type="button" class="secondary" data-act="csv">Export CSV</button>
    <button type="button" class="secondary" data-act="reload">Reload</button>
    <span class="mode">${ADMIN ? 'Click a task to edit it; drag a bar to move it, its ends to change start or deadline.' : 'Read only: click a task to see its details.'}</span>
  </div>`;
}

function legend() {
  return `<ul class="legend">${STATUS.map(([k, l]) => `<li><span class="sw ${k}"></span>${l}</li>`).join('')}
    <li>▲ latest useful start</li><li>→ dependency (dashed: the required task ends after the planned start)</li></ul>`;
}

/* ---------- Gantt view ---------- */
function gantt(all) {
  const ts = filterTasks(all, ui.gteam, ui.q, ui.hideDone)
    .filter((t) => !(t.parent_id && ui.collapsed.has(t.parent_id)));
  if (!ts.length) return toolbar(true) + legend() + '<div class="gwrap"><div class="empty">No task matches these filters.</div></div>';

  const byId = new Map(all.map((t) => [t.id, t]));
  const evDays = EVENTS.map((e) => dn(e.event_date));
  const minStart = Math.min(...all.map((t) => dn(t.start_date)), ...evDays, TN);
  const maxEnd = Math.max(...all.map((t) => dn(t.end_date)), ...evDays, TN);
  const d0 = new Date(minStart * 864e5);
  const d1 = new Date(maxEnd * 864e5);
  const RS = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), 1) / 864e5;
  const RE = Date.UTC(d1.getUTCFullYear(), d1.getUTCMonth() + 1, 0) / 864e5;
  const PX = ui.px, RH = 30, HH = 56, W = (RE - RS + 1) * PX + 70;
  const lw = window.innerWidth <= 640 ? 150 : 310;

  let months = '', ticks = '', refs = '';
  for (let y = d0.getUTCFullYear(), m = d0.getUTCMonth(); ; m++) {
    const a = Date.UTC(y, m, 1) / 864e5, b = Date.UTC(y, m + 1, 1) / 864e5;
    if (a > RE) break;
    const dt = new Date(a * 864e5);
    months += `<div class="mo" style="left:${(a - RS) * PX}px;width:${(Math.min(b, RE + 1) - a) * PX}px">${MON[dt.getUTCMonth()]} ${dt.getUTCFullYear()}</div>`;
  }
  for (let d = RS; d <= RE; d++) {
    const dt = new Date(d * 864e5);
    if (dt.getUTCDay() === 1) ticks += `<span class="wk" style="left:${(d - RS) * PX}px">${dt.getUTCDate()}</span>`;
  }

  const lines = [];
  refs += `<span class="ref today" style="left:${(TN - RS) * PX + PX / 2}px">today</span>`;
  lines.push([(TN - RS) * PX + PX / 2, 'var(--accent)', '']);
  all.filter((t) => t.milestone_label).forEach((m) => {
    const x = (dn(m.end_date) - RS) * PX + PX / 2;
    refs += `<span class="ref mile" style="left:${x}px">${esc(m.milestone_label)}</span>`;
    lines.push([x, 'var(--text)', '4 3']);
  });
  EVENTS.forEach((ev) => {
    const x = (dn(ev.event_date) - RS) * PX + PX / 2;
    const tip = `${ev.label} · ${formatDate(ev.event_date)}${ev.note ? `\n${ev.note}` : ''}`;
    refs += `<span class="ref event" style="left:${x}px" title="${esc(tip)}">${esc(ev.label)}</span>`;
    lines.push([x, 'var(--st-risk)', '4 3']);
  });

  let rows = '';
  const pos = {};
  ts.forEach((t, i) => {
    const s = dn(t.start_date), e = dn(t.end_date);
    const w = Math.max((e - s + 1) * PX, 10), l = (s - RS) * PX, mile = (e - s) <= 0;
    pos[t.id] = { i, l, r: l + w };
    const tip = `${t.code} · ${t.name}\nLeader: ${t.leaderName || '—'}\nResponsible: ${t.responsible ?? ''}\nStatus: ${STATUS_LABEL[t.status]}${t.late ? ' (overdue)' : ''}` +
      `\nStart: ${formatDate(t.start_date)} · Deadline: ${formatDate(t.end_date)}` +
      `\nEstimated duration: ${t.duration_days} d · latest useful start: ${formatDate(t.ls)}` +
      (t.parentCode ? `\nSubtask of ${t.parentCode}` : '') + (t.note ? `\n${t.note}` : '');
    const lsx = (dn(t.ls) - RS) * PX + PX / 2;
    const nChildren = all.filter((c) => c.parent_id === t.id).length;
    const caret = t.hasChildren
      ? `<button type="button" class="caret" data-toggle="${t.id}" aria-expanded="${!ui.collapsed.has(t.id)}"
          title="${ui.collapsed.has(t.id) ? `Show ${nChildren} subtasks` : 'Hide subtasks'}">${ui.collapsed.has(t.id) ? '▸' : '▾'}</button>`
      : '<span class="caret-sp"></span>';
    const addSub = ADMIN && t.depth === 0
      ? `<button type="button" class="addsub" data-addsub="${t.id}" title="Add a subtask to ${esc(t.code)}">+</button>` : '';
    rows += `<div class="grow" style="height:${RH}px">
      <div class="glabel${t.depth ? ' sub' : ''}" title="${esc(tip)}">${t.depth ? '' : caret}
        <a href="#" class="tlink" data-open="${t.id}"><span class="code">${esc(t.code)}</span><span class="n">${esc(t.name)}</span></a>${addSub}</div>
      <div class="track" style="width:${W}px">
        <div class="bar ${t.cls}${mile ? ' mile' : ''}${t.hasChildren ? ' parent' : ''}${ADMIN ? ' drag' : ''}" data-bar="${t.id}" data-open="${t.id}"
          style="left:${l}px;width:${w}px" title="${esc(tip)}">${ADMIN && !mile ? '<span class="hd l"></span><span class="hd r"></span>' : ''}</div>
        ${t.status !== 'done' ? `<span class="ls${t.over ? ' bad' : ''}" style="left:${lsx}px"></span>` : ''}
        <span class="bd" style="left:${l + w + 6}px">${fmtS(t.end_date)}</span>
      </div></div>`;
  });

  let arrows = '';
  ts.forEach((t) => t.requiredByIds.forEach((succId) => {
    const a = pos[t.id], b = pos[succId];
    if (!a || !b) return;
    const y1 = a.i * RH + RH / 2, y2 = b.i * RH + RH / 2, x1 = a.r, x2 = b.l;
    const tight = dn(t.end_date) > dn(byId.get(succId).start_date);
    const col = tight ? 'var(--st-late)' : 'var(--muted)';
    arrows += `<path d="M${x1} ${y1} H${x1 + 8} V${y2} H${x2}" fill="none" stroke="${col}" stroke-width="1.2"${tight ? ' stroke-dasharray="3 2"' : ''}/>` +
      `<path d="M${x2} ${y2} l-5 -3 v6 z" fill="${col}"/>`;
  }));
  const svg = `<svg class="arrows" style="left:${lw}px;top:${HH}px" width="${W}" height="${ts.length * RH}" aria-hidden="true">` +
    lines.map(([x, c, dash]) => `<line x1="${x}" x2="${x}" y1="0" y2="${ts.length * RH}" stroke="${c}" stroke-width="1"${dash ? ` stroke-dasharray="${dash}"` : ''} opacity=".7"/>`).join('') +
    arrows + '</svg>';

  ui.ganttStart = RS;
  return toolbar(true) + legend() +
    `<div class="gwrap" id="gw"><div class="ginner" style="--lw:${lw}px;--wk:${7 * PX}px;--off:${((1 - new Date(RS * 864e5).getUTCDay() + 7) % 7) * PX}px">
      <div class="grow hdr" style="height:${HH}px"><div class="glabel">Task</div><div class="track" style="width:${W}px">${months}${ticks}${refs}</div></div>
      ${rows}${svg}</div></div>
    <p class="hint">Bars run from the planned start to the deadline. Start dates and durations are effort estimates.
    ${ADMIN ? 'Drag a bar to move it, its left or right end to change start or deadline; Esc cancels a drag. Click a task to open the editor.' : 'Click a task to see its details.'}</p>`;
}

/* ---------- Table view ---------- */
function leaderSelect(t) {
  const def = t.defaultLeader ? `Default: ${nameOfPerson(t.defaultLeader)} (${t.defaultSource})` : 'Default: none';
  const options = eligibleLeaders().map(([id, p]) =>
    `<option value="${id}"${id === t.leader_id ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
  const warn = t.invalidOverride ? '<span class="req bad">Override not valid any more</span>'
    : (!t.leader && t.status !== 'done' ? '<span class="req bad">No leader</span>' : '');
  return `<select data-id="${t.id}" data-f="leader_id" aria-label="Leader of ${esc(t.code)}"${ADMIN ? '' : ' disabled'}>
    <option value="">${esc(def)}</option>${options}</select>${warn}`;
}

function pickList(kind, t, items, summary) {
  const key = `${kind}:${t.id}`;
  return `<details class="pick" data-key="${key}"${ui.open === key ? ' open' : ''}><summary>${esc(summary)}</summary>
    <div class="picklist">${items}</div></details>`;
}

function requiredByEditor(t) {
  const items = '<p class="hint" style="margin:0 0 4px">This task is required by:</p>' +
    ALL.filter((x) => x.id !== t.id).map((x) =>
      `<label class="pk"><input type="checkbox" data-reqof="${t.id}" value="${x.id}"${t.requiredByIds.includes(x.id) ? ' checked' : ''}${ADMIN ? '' : ' disabled'}>
        <span class="code">${esc(x.code)}</span> ${esc(x.name)}</label>`).join('');
  return pickList('req', t, items, t.requiredBy.length ? `Required by ${t.requiredBy.join(', ')}` : 'No dependants');
}

function teamsEditor(t) {
  const items = TEAMS.map((k) =>
    `<label class="pk"><input type="checkbox" data-teamof="${t.id}" value="${k}"${t.teams.includes(k) ? ' checked' : ''}${ADMIN ? '' : ' disabled'}> ${k}</label>`).join('');
  return pickList('teams', t, items, t.teams.length ? t.teams.join(', ') : 'No sub-team');
}

function parentSelect(t) {
  const options = ALL.filter((x) => x.depth === 0 && x.id !== t.id)
    .map((x) => `<option value="${x.id}"${x.id === t.parent_id ? ' selected' : ''}>${esc(x.code)}</option>`).join('');
  const disabled = !ADMIN || t.hasChildren;
  return `<select data-id="${t.id}" data-f="parent_id" aria-label="Parent of ${esc(t.code)}"${disabled ? ' disabled' : ''}
    title="${t.hasChildren ? 'Has subtasks: cannot become a subtask' : 'Parent task'}">
    <option value="">— none —</option>${options}</select>`;
}

function rowHtml(t) {
  const dis = ADMIN ? '' : ' disabled';
  const input = (f, type, value, label, extra = '') =>
    `<input type="${type}" data-id="${t.id}" data-f="${f}" value="${esc(value)}" aria-label="${label} ${esc(t.code)}"${extra}${dis}>`;
  const actions = !ADMIN ? '' : ui.confirmDel === t.id
    ? `<button type="button" class="act danger" data-act="del2" data-id="${t.id}">Delete${t.hasChildren ? ' with subtasks' : ''}?</button>`
    : `<button type="button" class="act secondary" data-act="del" data-id="${t.id}" title="Delete the task">✕</button>`;
  return `<tr class="r-${t.cls}${t.depth ? ' sub' : ''}">
    <td><span class="code-cell">${input('code', 'text', t.code, 'Code', ' maxlength="20" style="width:80px"')}
      <button type="button" class="act secondary" data-open="${t.id}" title="Open the editor">${ADMIN ? '✎' : 'ⓘ'}</button></span>${requiredByEditor(t)}</td>
    <td>${parentSelect(t)}</td>
    <td>${input('end_date', 'date', t.end_date, 'Deadline')}</td>
    <td>${input('name', 'text', t.name, 'Activity')}${input('note', 'text', t.note ?? '', 'Note', ' class="note-in" placeholder="Note"')}</td>
    <td>${leaderSelect(t)}</td>
    <td>${input('responsible', 'text', t.responsible ?? '', 'Responsible')}</td>
    <td>${statusSelect(t)}</td>
    <td>${teamsEditor(t)}</td>
    <td class="x">${input('start_date', 'date', t.start_date, 'Start')}</td>
    <td>${input('duration_days', 'number', t.duration_days, 'Duration', ' min="1" style="width:70px"')}</td>
    <td class="mono ${t.over ? 'bad' : ''}">${formatDate(t.ls)}${t.over ? ' ▲' : ''}</td>
    <td>${input('milestone_label', 'text', t.milestone_label ?? '', 'Milestone', ' placeholder="—" style="width:120px"')}</td>
    <td style="white-space:nowrap">${actions}</td></tr>`;
}

function table(all) {
  const ts = filterTasks(all, 'All', ui.q, ui.hideDone);
  const parentOptions = all.filter((x) => x.depth === 0)
    .map((x) => `<option value="${x.id}">${esc(x.code)}</option>`).join('');
  const addRow = !ADMIN ? '' : `<tr>
    <td><input type="text" id="n-code" placeholder="Code" maxlength="20" style="width:80px"></td>
    <td><select id="n-parent"><option value="">— none —</option>${parentOptions}</select></td>
    <td><input type="date" id="n-end"></td>
    <td><input type="text" id="n-name" placeholder="New activity"></td>
    <td><input type="text" id="n-resp" placeholder="Responsible"></td>
    <td></td><td colspan="7"><button type="button" data-act="add">Add task</button></td></tr>`;
  return toolbar(false) +
    `<div class="tw"><table><thead><tr>
      <th>Code and dependants</th><th>Parent</th><th>Deadline</th><th>Activity and note</th><th>Leader</th><th>Responsible</th><th>Status</th><th>Sub-teams</th>
      <th class="x">Start (estimate)</th><th>Duration (d)</th><th>Latest start</th><th>Milestone</th><th></th>
    </tr></thead><tbody>${ts.map(rowHtml).join('')}${addRow}</tbody></table></div>
    <p class="hint">"Required by" lists the tasks that cannot start before this one ends. "Parent" turns a task into a subtask (one level only).
    A milestone label shows the task deadline as a reference line in the Gantt and as a countdown on top.</p>`;
}

/* ---------- Sub-teams view ---------- */
function subteams(all) {
  const team = ui.team;
  const ts = all.filter((t) => t.teams.includes(team));
  const chips = '<div class="team-chips">' + TEAMS.map((k) => {
    const n = all.filter((t) => t.teams.includes(k)).length;
    return `<button type="button" data-act="team" data-t="${k}" aria-pressed="${k === team}">${k} · ${n}</button>`;
  }).join('') + '</div>';
  let h = `${chips}<h2 class="g-h2">${team} <small>${ts.length} tasks, ${ts.filter((t) => t.status === 'done').length} done</small></h2>`;
  if (!ts.length) return `${h}<div class="empty">No task assigned to this sub-team.</div>`;
  h += `<div class="tw short"><table><thead><tr><th>Code and dependants</th><th>Deadline</th><th>Activity</th><th>Leader</th><th>Responsible</th><th>Status</th><th class="x">Start</th><th>Latest start</th></tr></thead><tbody>` +
    ts.map((t) => `<tr class="r-${t.cls}${t.depth ? ' sub' : ''}"><td><a href="#" class="code" data-open="${t.id}">${esc(t.code)}</a>${reqText(t) ? `<span class="req">${esc(reqText(t))}</span>` : ''}</td>
      <td class="mono">${formatDate(t.end_date)}</td><td>${esc(t.name)}${t.note ? `<br><span class="note">${esc(t.note)}</span>` : ''}</td>
      <td>${esc(t.leaderName || "—")}</td><td>${esc(t.responsible)}</td><td>${statusSelect(t)}</td><td class="mono x">${formatDate(t.start_date)}</td>
      <td class="mono ${t.over ? 'bad' : ''}">${formatDate(t.ls)}${t.over ? ' ▲' : ''}</td></tr>`).join('') +
    '</tbody></table></div><p class="hint">A task with several sub-teams appears in each of them. Sub-teams are edited in the Table view.</p>';
  return h;
}

/* ---------- This week view ---------- */
function week(all) {
  const open = all.filter((t) => t.status !== 'done');
  const late = open.filter((t) => t.end_date < TODAY);
  const soon = open.filter((t) => t.end_date >= TODAY && dn(t.end_date) <= TN + 7);
  const shouldHaveStarted = open.filter((t) => t.status === 'todo' && t.start_date < TODAY && t.end_date >= TODAY);
  const startSoon = open.filter((t) => t.status === 'todo' && t.start_date >= TODAY && dn(t.start_date) <= TN + 7);
  const list = (title, items, none) => {
    const h = `<h2 class="g-h2">${title} <small>${items.length}</small></h2>`;
    if (!items.length) return `${h}<div class="empty" style="padding:14px;text-align:left">${none}</div>`;
    return h + '<div class="tw short"><table><tbody>' + items.map((x) =>
      `<tr class="r-${x.cls}"><td style="width:56px"><a href="#" class="code" data-open="${x.id}">${esc(x.code)}</a></td>
        <td>${esc(x.name)}<span class="req">${esc(x.leaderName ? `Leader: ${x.leaderName}` : "No leader")}${x.responsible ? ` · ${esc(x.responsible)}` : ""}</span></td>
        <td class="mono" style="white-space:nowrap">start ${fmtS(x.start_date)}<span class="req">due ${fmtS(x.end_date)}</span></td>
        <td style="width:150px">${statusSelect(x)}</td></tr>`).join('') + '</tbody></table></div>';
  };
  return `<p class="g-sub" style="margin-bottom:6px">For the board meeting · today ${formatDate(TODAY)}</p>` +
    list('Overdue and not done', late, 'No overdue task.') +
    list('Due in the next 7 days', soon, 'No deadline in the next 7 days.') +
    list('Should have started (planned start passed, status To do)', shouldHaveStarted, 'All tasks planned to start are started.') +
    list('Starting in the next 7 days', startSoon, 'No start planned in the next 7 days.');
}

/* ---------- Timeline events view ---------- */
function events() {
  const dis = ADMIN ? '' : ' disabled';
  const rows = EVENTS.map((ev) => `<tr>
    <td><input type="date" data-ev="${ev.id}" data-f="event_date" value="${esc(ev.event_date)}" aria-label="Date"${dis}></td>
    <td><input type="text" data-ev="${ev.id}" data-f="label" value="${esc(ev.label)}" maxlength="40" aria-label="Label"${dis}></td>
    <td><input type="text" data-ev="${ev.id}" data-f="note" value="${esc(ev.note ?? '')}" placeholder="Note" aria-label="Note"${dis}></td>
    <td class="mono">${dn(ev.event_date) - TN} d</td>
    <td style="white-space:nowrap">${!ADMIN ? '' : ui.confirmDel === `ev${ev.id}`
      ? `<button type="button" class="act danger" data-act="evdel2" data-id="${ev.id}">Delete?</button>`
      : `<button type="button" class="act secondary" data-act="evdel" data-id="${ev.id}" title="Delete the event">✕</button>`}</td></tr>`).join('');
  const addRow = !ADMIN ? '' : `<tr>
    <td><input type="date" id="ev-date"></td>
    <td><input type="text" id="ev-label" maxlength="40" placeholder="Label"></td>
    <td><input type="text" id="ev-note" placeholder="Note"></td>
    <td colspan="2"><button type="button" data-act="evadd">Add event</button></td></tr>`;
  return `<p class="g-sub" style="margin-bottom:8px">Fixed external dates around which the work is planned. They are shown as vertical lines in the Gantt; they are not tasks.</p>
    <div class="tw short"><table><thead><tr><th>Date</th><th>Label</th><th>Note</th><th>From today</th><th></th></tr></thead>
    <tbody>${rows || (ADMIN ? '' : '<tr><td colspan="5" class="hint">No event.</td></tr>')}${addRow}</tbody></table></div>`;
}

async function eventWrite(query, message) {
  const { error } = await query;
  ui.confirmDel = null;
  if (error) {
    toast(/timeline_events_label_check/.test(error.message) ? 'Label required (max 40 characters).' : errorText(error));
  }
  await reload(error ? undefined : message);
}

/* ---------- CSV ---------- */
function exportCsv() {
  const rows = [['Code', 'Parent', 'Required by', 'Deadline', 'Activity', 'Leader', 'Responsible', 'Status', 'Sub-teams',
    'Start (estimate)', 'Duration (d)', 'Latest start', 'Milestone', 'Note']];
  ALL.forEach((t) => rows.push([t.code, t.parentCode ?? '', t.requiredBy.join(' '), formatDate(t.end_date), t.name, t.leaderName,
    t.responsible ?? '', STATUS_LABEL[t.status], t.teams.join(' '), formatDate(t.start_date), t.duration_days,
    formatDate(t.ls), t.milestone_label ?? '', t.note ?? '']));
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\r\n');
  download(`gantt_${TODAY}.csv`, `﻿${csv}`, 'text/csv');
}

/* ---------- task editor ---------- */
// Transitive check on the dependency graph: does `from` depend (directly or not) on `to`?
// edges: Map task id -> Set of ids it depends on
function dependsOnPath(edges, from, to) {
  const seen = new Set();
  const stack = [from];
  while (stack.length) {
    const x = stack.pop();
    if (x === to) return true;
    if (seen.has(x)) continue;
    seen.add(x);
    (edges.get(x) ?? []).forEach((y) => stack.push(y));
  }
  return false;
}

function graphWith(taskId, dependsOn, requiredBy) {
  const edges = new Map();
  DEPS.forEach(({ task_id: t, depends_on: d }) => {
    if (t === taskId || d === taskId) return;          // edges of the edited task: from the form
    if (!edges.has(t)) edges.set(t, new Set());
    edges.get(t).add(d);
  });
  if (taskId != null) {
    edges.set(taskId, new Set(dependsOn));
    requiredBy.forEach((r) => { if (!edges.has(r)) edges.set(r, new Set()); edges.get(r).add(taskId); });
  }
  return edges;
}

const modal = () => document.getElementById('g-modal');
function closeModal() { const m = modal(); m.hidden = true; m.innerHTML = ''; m.onclose = null; }
function requestClose() {
  const m = modal();
  if (m.dirty && !window.confirm('Discard the unsaved changes?')) return;
  closeModal();
}

// id: existing task, or null for a new one; preset: initial values of a new task
function openEditor(id, preset = {}) {
  const t = id != null ? ALL.find((x) => x.id === id) : null;
  if (id != null && !t) { toast(ERRORS['Task not found']); return; }
  const ro = !ADMIN;
  const dis = ro ? ' disabled' : '';
  const v = t ? { ...t } : {
    code: '', name: '', parent_id: null, status: 'todo', start_date: TODAY, end_date: iso(TN + DEFAULT_DURATION),
    duration_days: DEFAULT_DURATION, leader_id: null, responsible: '', note: '', teams: [], milestone_label: '', ...preset,
  };
  const deps = new Set(t ? t.dependsOnIds : preset.dependsOnIds ?? []);
  const reqs = new Set(t ? t.requiredByIds : []);
  const children = t ? ALL.filter((x) => x.parent_id === t.id) : [];
  const parentChoices = ALL.filter((x) => x.depth === 0 && x.id !== id);

  const m = modal();
  m.dirty = false;
  m.innerHTML = `<div class="mbox wide" role="dialog" aria-modal="true" aria-labelledby="ed-title">
    <h2 id="ed-title">${t ? `${ro ? '' : 'Edit '}${esc(t.code)} – ${esc(t.name)}` : v.parent_id ? 'New subtask' : 'New task'}</h2>
    ${t ? `<p class="meta">Last change ${t.updated_at ? new Date(t.updated_at).toLocaleString('en-GB', { timeZone: TIME_ZONE }) : '—'}${t.updated_by ? ` by ${esc(nameOfPerson(t.updated_by))}` : ''}</p>` : ''}
    <form id="ed-form" novalidate>
      <div class="ed-grid">
        <div><label for="ed-code">Code *</label><input id="ed-code" maxlength="20" value="${esc(v.code)}" required${dis}></div>
        <div class="span2"><label for="ed-name">Activity *</label><input id="ed-name" maxlength="200" value="${esc(v.name)}" required${dis}></div>
        <div><label for="ed-parent">Parent task</label><select id="ed-parent"${ro || (t && t.hasChildren) ? ' disabled' : ''}
            title="${t && t.hasChildren ? 'Has subtasks: cannot become a subtask' : ''}">
          <option value="">— none (top-level task) —</option>${parentChoices.map((x) =>
            `<option value="${x.id}"${x.id === v.parent_id ? ' selected' : ''}>${esc(x.code)} – ${esc(x.name.slice(0, 60))}</option>`).join('')}</select></div>
        <div><label for="ed-status">Status</label><select id="ed-status"${dis}>${STATUS.map(([k, l]) =>
          `<option value="${k}"${k === v.status ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
        <div><label for="ed-milestone">Milestone label</label><input id="ed-milestone" maxlength="40" placeholder="none" value="${esc(v.milestone_label ?? '')}"${dis}></div>
        <div><label for="ed-start">Start (estimate) *</label><input id="ed-start" type="date" value="${esc(v.start_date)}" required${dis}></div>
        <div><label for="ed-end">Deadline *</label><input id="ed-end" type="date" value="${esc(v.end_date)}" required${dis}></div>
        <div><label for="ed-dur">Duration (working estimate, days) *</label><input id="ed-dur" type="number" min="1" max="3650" value="${esc(v.duration_days)}"${dis}>
          <span class="req" id="ed-ls"></span></div>
        <div><label for="ed-leader">Leader</label><select id="ed-leader"${dis}></select></div>
        <div class="span2"><label for="ed-resp">Responsible (who carries out the work)</label><input id="ed-resp" maxlength="200" value="${esc(v.responsible ?? '')}"${dis}></div>
        <div class="span3"><span class="lbl">Sub-teams</span><div class="ed-teams">${TEAMS.map((k) =>
          `<label class="pk"><input type="checkbox" name="ed-team" value="${k}"${v.teams.includes(k) ? ' checked' : ''}${dis}> ${k}</label>`).join('')}</div></div>
        <div class="span3"><label for="ed-note">Note</label><textarea id="ed-note" maxlength="500" rows="2"${dis}>${esc(v.note ?? '')}</textarea></div>
      </div>

      <h3>Dependencies</h3>
      <div class="ed-deps">
        <div><span class="lbl">Depends on <span class="hint">(shall end before this task starts)</span></span>
          <div class="chips" id="ed-deps"></div>${ro ? '' : '<select id="ed-add-dep" aria-label="Add a task this one depends on"></select>'}</div>
        <div><span class="lbl">Required by <span class="hint">(cannot start before this task ends)</span></span>
          <div class="chips" id="ed-reqs"></div>${ro ? '' : '<select id="ed-add-req" aria-label="Add a task that depends on this one"></select>'}</div>
      </div>

      <div id="ed-warn"></div>

      ${t && t.depth === 0 ? `<h3>Subtasks (${children.length})</h3>
        ${children.length ? `<ul class="ed-children">${children.map((c) => `<li><a href="#" data-goto="${c.id}"><span class="code">${esc(c.code)}</span> ${esc(c.name)}</a>
          <span class="hint">${formatDate(c.start_date)} – ${formatDate(c.end_date)} · ${STATUS_LABEL[c.status]}</span></li>`).join('')}</ul>` : '<p class="hint">None.</p>'}
        ${ro ? '' : '<button type="button" class="secondary" data-ed="add-sub">Add subtask</button>'}` : ''}

      ${t ? '<details class="ed-hist" id="ed-hist"><summary>Change history</summary><div id="ed-hist-body"><p class="hint">Loading…</p></div></details>' : ''}

      <p class="message" id="ed-msg" role="alert" hidden></p>
      <div class="buttons">
        ${t && !ro ? '<button type="button" class="danger" data-ed="delete">Delete…</button>' : ''}
        ${t && !ro ? '<button type="button" class="secondary" data-ed="duplicate">Duplicate</button>' : ''}
        <span class="spacer"></span>
        <button type="button" class="secondary" data-ed="close">${ro ? 'Close' : 'Cancel'}</button>
        ${ro ? '' : `<button type="submit">${t ? 'Save' : 'Create'}</button>`}
      </div>
    </form></div>`;
  m.hidden = false;
  const box = m.querySelector('.mbox');
  const $ = (sel) => box.querySelector(sel);
  const msg = (text, kind = 'error') => { const p = $('#ed-msg'); p.textContent = text; p.className = `message ${kind}`; p.hidden = !text; };

  // Leader menu: default (sub-team or parent) or explicit leader
  let leaderValue = v.leader_id ?? '';
  const fillLeader = () => {
    const teams = [...box.querySelectorAll('input[name="ed-team"]:checked')].map((i) => i.value);
    const parentId = Number($('#ed-parent').value) || null;
    const probe = { teams };
    const team = teamLeader(probe);
    const parent = parentId ? ALL.find((x) => x.id === parentId)?.leader ?? null : null;
    const def = team ?? parent;
    const current = leaderValue;
    $('#ed-leader').innerHTML = `<option value="">${esc(def ? `Default: ${nameOfPerson(def)} (${team ? 'sub-team' : 'parent task'})` : 'Default: none')}</option>` +
      eligibleLeaders().map(([pid, p]) => `<option value="${pid}"${pid === current ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
  };

  // Dependency chips and add-menus (options that would create a loop are disabled)
  const label = (x) => `${x.code} – ${x.name.length > 50 ? `${x.name.slice(0, 50)}…` : x.name}`;
  const fillDeps = () => {
    const chip = (sid, kind) => {
      const x = ALL.find((y) => y.id === sid);
      return `<span class="chip"><a href="#" data-goto="${sid}" title="${esc(x?.name ?? '')}">${esc(x?.code ?? '?')}</a>${ro ? '' : `<button type="button" data-rm="${kind}" data-tid="${sid}" aria-label="Remove ${esc(x?.code ?? '')}">×</button>`}</span>`;
    };
    $('#ed-deps').innerHTML = [...deps].map((d) => chip(d, 'dep')).join('') || '<span class="hint">none</span>';
    $('#ed-reqs').innerHTML = [...reqs].map((d) => chip(d, 'req')).join('') || '<span class="hint">none</span>';
    if (ro) return;
    const self = id ?? -1;
    const edges = graphWith(self, deps, reqs);
    const opts = (kind) => ALL.filter((x) => x.id !== self && !deps.has(x.id) && !reqs.has(x.id)).map((x) => {
      // kind dep: self would depend on x -> loop if x depends on self
      // kind req: x would depend on self -> loop if self depends on x
      const loop = kind === 'dep' ? dependsOnPath(edges, x.id, self) : dependsOnPath(edges, self, x.id);
      return `<option value="${x.id}"${loop ? ' disabled' : ''}>${esc(label(x))}${loop ? ' (would create a loop)' : ''}</option>`;
    }).join('');
    $('#ed-add-dep').innerHTML = `<option value="">+ add a task this one depends on…</option>${opts('dep')}`;
    $('#ed-add-req').innerHTML = `<option value="">+ add a task that depends on this one…</option>${opts('req')}`;
  };

  // Live warnings
  const warn = () => {
    const start = $('#ed-start').value, end = $('#ed-end').value;
    const dur = Math.max(1, Math.round(Number($('#ed-dur').value) || 1));
    const out = [];
    if (start && end) {
      const ls = iso(dn(end) - dur);
      $('#ed-ls').textContent = `Latest useful start: ${formatDate(ls)}`;
      if (end < start) out.push(['error', 'The deadline precedes the start.']);
      if (start > ls && $('#ed-status').value !== 'done') out.push(['warn', `The start is after the latest useful start (${formatDate(ls)}): the deadline is at risk.`]);
      if (end < TODAY && $('#ed-status').value !== 'done') out.push(['warn', 'The deadline has passed and the task is not done.']);
      const tight = [...deps].map((d) => ALL.find((x) => x.id === d)).filter((x) => x && x.end_date >= start);
      if (tight.length) {
        out.push(['warn', `Starts before the end of ${tight.map((x) => `${x.code} (${formatDate(x.end_date)})`).join(', ')}.` +
          (ro ? '' : ' <button type="button" class="link" data-ed="align">Move the start after them</button>')]);
      }
      const late = [...reqs].map((r) => ALL.find((x) => x.id === r)).filter((x) => x && x.start_date <= end);
      if (late.length) out.push(['warn', `Ends after the start of ${late.map((x) => `${x.code} (${formatDate(x.start_date)})`).join(', ')}, which depend${late.length === 1 ? 's' : ''} on it.`]);
      const parentId = Number($('#ed-parent').value) || null;
      const parent = parentId ? ALL.find((x) => x.id === parentId) : null;
      if (parent && (start < parent.start_date || end > parent.end_date)) {
        out.push(['warn', `Outside the dates of the parent task ${parent.code} (${formatDate(parent.start_date)} – ${formatDate(parent.end_date)}).`]);
      }
      const outChildren = children.filter((c) => c.start_date < start || c.end_date > end);
      if (outChildren.length) out.push(['warn', `Subtasks outside these dates: ${outChildren.map((c) => c.code).join(', ')}.`]);
    }
    const teams = [...box.querySelectorAll('input[name="ed-team"]:checked')];
    if (!$('#ed-leader').value && $('#ed-leader').selectedOptions[0]?.textContent === 'Default: none' && $('#ed-status').value !== 'done') {
      out.push(['warn', teams.length ? 'No leader: no leader is set for these sub-teams.' : 'No leader: select a sub-team or a leader.']);
    }
    $('#ed-warn').innerHTML = out.length ? `<ul class="ed-warn">${out.map(([k, txt]) => `<li class="${k}">${txt}</li>`).join('')}</ul>` : '';
  };

  fillLeader();
  fillDeps();
  warn();

  // History (loaded when opened)
  $('#ed-hist')?.addEventListener('toggle', async (e) => {
    if (!e.target.open || e.target.dataset.loaded) return;
    e.target.dataset.loaded = '1';
    const { data, error } = await supabase.from('task_history').select('*')
      .or(`task_id.eq.${t.id},changes->>depends_on.eq."${t.code.replace(/"/g, '')}"`)
      .order('changed_at', { ascending: false }).limit(100);
    const body = $('#ed-hist-body');
    if (error) { body.innerHTML = `<p class="message error">${esc(errorText(error))}</p>`; return; }
    if (!data.length) { body.innerHTML = '<p class="hint">No change recorded yet.</p>'; return; }
    const show = (val) => (val == null ? '—' : Array.isArray(val) ? val.join(', ') || '—' : String(val));
    const field = (k) => ({ end_date: 'deadline', start_date: 'start', duration_days: 'duration', parent_id: 'parent', leader_id: 'leader', milestone_label: 'milestone' }[k] ?? k);
    const valueOf = (k, val) => (k === 'leader_id' ? nameOfPerson(val) || '—' : k === 'parent_id' ? (ROWS.find((r) => r.id === val)?.code ?? show(val))
      : k === 'status' ? STATUS_LABEL[val] ?? show(val) : /date/.test(k) && val ? formatDate(val) : show(val));
    body.innerHTML = `<ul class="hist">${data.map((h) => {
      const when = new Date(h.changed_at).toLocaleString('en-GB', { timeZone: TIME_ZONE, dateStyle: 'short', timeStyle: 'short' });
      let what = esc(h.action);
      if (h.action === 'updated') {
        what = Object.entries(h.changes).map(([k, [a, b]]) => `${esc(field(k))}: ${esc(valueOf(k, a))} → ${esc(valueOf(k, b))}`).join('; ');
      } else if (h.action.startsWith('dependency')) {
        what = h.task_id === t.id ? `${esc(h.action)}: depends on ${esc(h.changes.depends_on)}` : `${esc(h.task_code)} ${esc(h.action.replace('dependency', 'dependency on this task'))}`;
      }
      return `<li><span class="mono">${esc(when)}</span> · ${esc(nameOfPerson(h.changed_by) || 'system')} · ${what}</li>`;
    }).join('')}</ul>`;
  });

  box.addEventListener('input', () => { m.dirty = true; warn(); });
  box.addEventListener('change', (e) => {
    m.dirty = true;
    if (e.target.id === 'ed-leader') leaderValue = e.target.value;
    if (e.target.id === 'ed-parent' || e.target.name === 'ed-team') fillLeader();
    if (e.target.id === 'ed-add-dep' && e.target.value) { deps.add(Number(e.target.value)); fillDeps(); }
    if (e.target.id === 'ed-add-req' && e.target.value) { reqs.add(Number(e.target.value)); fillDeps(); }
    warn();
  });

  box.addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      (rm.dataset.rm === 'dep' ? deps : reqs).delete(Number(rm.dataset.tid));
      m.dirty = true; fillDeps(); warn(); return;
    }
    const go = e.target.closest('[data-goto]');
    if (go) {
      e.preventDefault();
      if (m.dirty && !window.confirm('Discard the unsaved changes?')) return;
      openEditor(Number(go.dataset.goto)); return;
    }
    const b = e.target.closest('[data-ed]');
    if (!b) return;
    const act = b.dataset.ed;
    if (act === 'close') requestClose();
    else if (act === 'align') {
      const latest = Math.max(...[...deps].map((d) => dn(ALL.find((x) => x.id === d).end_date)));
      const span = dn($('#ed-end').value) - dn($('#ed-start').value);
      $('#ed-start').value = iso(latest + 1);
      if ($('#ed-end').value < $('#ed-start').value) $('#ed-end').value = iso(latest + 1 + Math.max(span, 0));
      m.dirty = true; warn();
    } else if (act === 'add-sub') {
      if (m.dirty && !window.confirm('Discard the unsaved changes?')) return;
      openEditor(null, { parent_id: t.id, teams: [...t.teams], start_date: t.start_date, end_date: t.end_date,
        duration_days: Math.min(t.duration_days, dn(t.end_date) - dn(t.start_date) + 1) });
    } else if (act === 'duplicate') {
      if (m.dirty && !window.confirm('Discard the unsaved changes?')) return;
      openEditor(null, { code: `${t.code}-copy`.slice(0, 20), name: t.name, parent_id: t.parent_id, status: 'todo',
        start_date: t.start_date, end_date: t.end_date, duration_days: t.duration_days, leader_id: t.leader_id,
        responsible: t.responsible ?? '', note: t.note ?? '', teams: [...t.teams], dependsOnIds: [...t.dependsOnIds] });
    } else if (act === 'delete') {
      const parts = [];
      if (children.length) parts.push(`${children.length} subtask(s) (${children.map((c) => c.code).join(', ')}) will be deleted as well`);
      const nDeps = t.dependsOnIds.length + t.requiredByIds.length;
      if (nDeps) parts.push(`${nDeps} dependency link(s) will be removed`);
      if (!window.confirm(`Delete ${t.code} – ${t.name}?${parts.length ? `\n\n${parts.join(';\n')}.` : ''}\n\nA task with lab shifts cannot be deleted.`)) return;
      b.disabled = true;
      const { error } = await supabase.from('tasks').delete().eq('id', t.id);
      if (error) { b.disabled = false; msg(errorText(error)); return; }
      closeModal();
      await reload(`${t.code} deleted.`);
    }
  });

  $('#ed-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (ro) return;
    const fields = {
      code: $('#ed-code').value.trim(),
      name: $('#ed-name').value.trim(),
      parent_id: Number($('#ed-parent').value) || null,
      status: $('#ed-status').value,
      milestone_label: $('#ed-milestone').value.trim() || null,
      start_date: $('#ed-start').value,
      end_date: $('#ed-end').value,
      duration_days: Math.round(Number($('#ed-dur').value)),
      leader_id: $('#ed-leader').value || null,
      responsible: $('#ed-resp').value.trim() || null,
      note: $('#ed-note').value.trim() || null,
      teams: TEAMS.filter((k) => box.querySelector(`input[name="ed-team"][value="${k}"]`).checked),
    };
    if (!CODE_RE.test(fields.code)) { msg('Code: 1 to 20 characters among letters, digits, ".", "-" and "_".'); $('#ed-code').focus(); return; }
    if (ROWS.some((r) => r.code.toLowerCase() === fields.code.toLowerCase() && r.id !== id)) { msg('Code already used by another task.'); $('#ed-code').focus(); return; }
    if (!fields.name) { msg('The activity is required.'); $('#ed-name').focus(); return; }
    if (!fields.start_date || !fields.end_date) { msg('Start and deadline are required.'); return; }
    if (fields.end_date < fields.start_date) { msg('The deadline cannot precede the start.'); $('#ed-end').focus(); return; }
    if (!(fields.duration_days >= 1)) { msg('The duration shall be at least 1 day.'); $('#ed-dur').focus(); return; }
    const submit = box.querySelector('button[type="submit"]');
    submit.disabled = true;
    const { data: savedId, error } = await supabase.rpc('admin_save_task', {
      p_id: id,
      p_fields: fields,
      p_depends_on: [...deps],
      p_required_by: [...reqs],
      p_expected: t ? t.updated_at : null,
    });
    if (error) {
      submit.disabled = false;
      msg(errorText(error));
      if (error.message === 'Task modified by someone else') {
        $('#ed-msg').insertAdjacentHTML('beforeend', ' <button type="button" class="link" data-ed="reload-open">Reload the task</button>');
        $('#ed-msg [data-ed="reload-open"]').addEventListener('click', async () => { closeModal(); await reload(); openEditor(id); });
      }
      return;
    }
    closeModal();
    if (fields.parent_id) { ui.collapsed.delete(fields.parent_id); store('gantt-collapsed', [...ui.collapsed]); }
    await reload(`${fields.code} ${t ? 'saved' : 'created'}.`);
    highlight(savedId);
  });

  (ro ? box.querySelector('[data-ed="close"]') : $('#ed-code')).focus();
}

// Brief highlight of a task in the current view after a save
function highlight(id) {
  document.querySelectorAll(`[data-open="${id}"]`).forEach((el) => {
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1600);
    if (el.classList.contains('tlink')) el.scrollIntoView({ block: 'nearest' });
  });
}

/* ---------- drag of the Gantt bars (admin) ---------- */
let drag = null;
let suppressClick = false;

function dragTip(text, x, y) {
  let tip = document.getElementById('drag-tip');
  if (!tip) { tip = document.createElement('div'); tip.id = 'drag-tip'; document.body.appendChild(tip); }
  tip.textContent = text;
  tip.style.left = `${x + 12}px`;
  tip.style.top = `${y + 12}px`;
  tip.hidden = !text;
}

document.addEventListener('pointerdown', (e) => {
  const bar = e.target.closest?.('.bar[data-bar]');
  if (!bar || !ADMIN || e.button !== 0) return;
  const t = ALL.find((x) => x.id === Number(bar.dataset.bar));
  if (!t) return;
  const mode = e.target.classList.contains('l') ? 'start' : e.target.classList.contains('r') ? 'end' : 'move';
  drag = { t, bar, mode, x0: e.clientX, left0: parseFloat(bar.style.left), width0: parseFloat(bar.style.width), moved: false, start: t.start_date, end: t.end_date };
  bar.setPointerCapture?.(e.pointerId);
  e.preventDefault();
});

document.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x0;
  if (Math.abs(dx) > 3) drag.moved = true;
  if (!drag.moved) return;
  const days = Math.round(dx / ui.px);
  let s = dn(drag.t.start_date), en = dn(drag.t.end_date);
  if (drag.mode === 'move') { s += days; en += days; }
  else if (drag.mode === 'start') s = Math.min(s + days, en);
  else en = Math.max(en + days, s);
  drag.start = iso(s);
  drag.end = iso(en);
  drag.bar.style.left = `${(s - ui.ganttStart) * ui.px}px`;
  drag.bar.style.width = `${Math.max((en - s + 1) * ui.px, 10)}px`;
  dragTip(`${drag.t.code}: ${formatDate(drag.start)} – ${formatDate(drag.end)}`, e.clientX, e.clientY);
});

async function endDrag(cancel) {
  const d = drag;
  drag = null;
  dragTip('', 0, 0);
  if (!d) return;
  if (!d.moved) return;          // a simple click: the click handler opens the editor
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 0);
  if (cancel || (d.start === d.t.start_date && d.end === d.t.end_date)) { render(); return; }
  const t = d.t;
  const { error } = await supabase.rpc('admin_save_task', {
    p_id: t.id,
    p_fields: {
      code: t.code, name: t.name, parent_id: t.parent_id, status: t.status, milestone_label: t.milestone_label,
      start_date: d.start, end_date: d.end, duration_days: t.duration_days, leader_id: t.leader_id,
      responsible: t.responsible, note: t.note, teams: t.teams,
    },
    p_depends_on: null,
    p_required_by: null,
    p_expected: t.updated_at,
  });
  if (error) { toast(errorText(error)); await reload(); return; }
  await reload(`${t.code}: ${formatDate(d.start)} – ${formatDate(d.end)}.`);
}

document.addEventListener('pointerup', () => endDrag(false));
document.addEventListener('pointercancel', () => endDrag(true));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (drag) { drag.moved = true; endDrag(true); return; }
  if (!modal().hidden) requestClose();
});

/* ---------- render ---------- */
function render() {
  const v = document.getElementById('view');
  document.getElementById('g-nav').innerHTML = VIEWS.map(([k, l]) =>
    `<a href="#${k}"${k === ui.view ? ' aria-current="page"' : ''}>${l}</a>`).join('');
  ALL = build();
  stats(ALL);
  const keep = document.getElementById('gw');
  const scroll = keep ? [keep.scrollLeft, keep.scrollTop] : null;
  v.innerHTML = ui.view === 'gantt' ? gantt(ALL) : ui.view === 'table' ? table(ALL)
    : ui.view === 'teams' ? subteams(ALL) : ui.view === 'events' ? events() : week(ALL);
  const gw = document.getElementById('gw');
  if (gw) {
    if (scroll) { [gw.scrollLeft, gw.scrollTop] = scroll; }
    else if (!render.done && ui.ganttStart != null) { gw.scrollLeft = Math.max(0, (TN - ui.ganttStart) * ui.px - 40); }
  }
  document.getElementById('g-sub').textContent = `RedPill (J2050) · ${ALL.length} tasks`;
  render.done = true;
}

/* ---------- events ---------- */
document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset.reqof) {
    ui.open = `req:${el.dataset.reqof}`;
    await setRequiredBy(Number(el.dataset.reqof), Number(el.value), el.checked);
    return;
  }
  if (el.dataset.teamof) {
    const id = Number(el.dataset.teamof);
    ui.open = `teams:${id}`;
    const teams = [...el.closest('.picklist').querySelectorAll('input[data-teamof]')]
      .filter((b) => b.checked).map((b) => b.value);
    await patchTask(id, { teams });
    return;
  }
  if (el.dataset.ev) {
    const f = el.dataset.f;
    let val = el.value.trim();
    if (f === 'event_date' && !val) { render(); return; }
    if (f === 'note') val = val || null;
    await eventWrite(supabase.from('timeline_events').update({ [f]: val }).eq('id', Number(el.dataset.ev)));
    return;
  }
  if (el.id === 'gteam') { ui.gteam = el.value; render(); return; }
  if (el.id === 'hd') { ui.hideDone = el.checked; render(); return; }

  const id = Number(el.dataset.id), f = el.dataset.f;
  if (!id || !f) return;
  let val = el.value;
  if ((f === 'end_date' || f === 'start_date') && !val) { render(); return; }
  if ((f === 'name' || f === 'code') && !val.trim()) { render(); return; }
  if (f === 'duration_days') val = Math.max(1, Math.round(Number(val) || 1));
  if (f === 'parent_id') val = val ? Number(val) : null;
  if (f === 'leader_id') val = val || null;
  if (['note', 'responsible', 'milestone_label'].includes(f)) val = val.trim() || null;
  if (f === 'name' || f === 'code') val = val.trim();
  await patchTask(id, { [f]: val });
});

document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (!d.classList?.contains('pick')) return;
  const key = d.dataset.key;
  if (d.open) ui.open = key; else if (ui.open === key) ui.open = null;
}, true);

document.addEventListener('input', (e) => {
  if (e.target.id !== 'q') return;
  ui.q = e.target.value;
  const p = e.target.selectionStart;
  render();
  const q = document.getElementById('q');
  if (q) { q.focus(); q.setSelectionRange(p, p); }
});

document.addEventListener('click', async (e) => {
  if (e.target.closest?.('#g-modal')) {
    if (e.target.id === 'g-modal') requestClose();   // click outside the dialog
    return;
  }
  if (suppressClick) { suppressClick = false; return; }
  const tog = e.target.closest?.('[data-toggle]');
  if (tog) {
    const pid = Number(tog.dataset.toggle);
    if (ui.collapsed.has(pid)) ui.collapsed.delete(pid); else ui.collapsed.add(pid);
    store('gantt-collapsed', [...ui.collapsed]);
    render();
    return;
  }
  const sub = e.target.closest?.('[data-addsub]');
  if (sub) {
    const p = ALL.find((x) => x.id === Number(sub.dataset.addsub));
    openEditor(null, { parent_id: p.id, teams: [...p.teams], start_date: p.start_date, end_date: p.end_date,
      duration_days: Math.min(p.duration_days, dn(p.end_date) - dn(p.start_date) + 1) });
    return;
  }
  const op = e.target.closest?.('[data-open]');
  if (op && !e.target.closest('input, select')) { e.preventDefault(); openEditor(Number(op.dataset.open)); return; }
  const b = e.target.closest?.('[data-act]');
  if (!b) return;
  const act = b.dataset.act, id = Number(b.dataset.id);
  if (act === 'new-task') openEditor(null);
  else if (act === 'zoom-in' || act === 'zoom-out') {
    const i = ZOOMS.indexOf(ui.px) + (act === 'zoom-in' ? 1 : -1);
    const gw = document.getElementById('gw');
    const centreDay = gw ? (gw.scrollLeft + gw.clientWidth / 2) / ui.px : null;
    ui.px = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i))];
    store('gantt-px', ui.px);
    render();
    const g2 = document.getElementById('gw');
    if (g2 && centreDay != null) g2.scrollLeft = Math.max(0, centreDay * ui.px - g2.clientWidth / 2);
  }
  else if (act === 'expand-all') { ui.collapsed.clear(); store('gantt-collapsed', []); render(); }
  else if (act === 'collapse-all') {
    ALL.filter((x) => x.hasChildren).forEach((x) => ui.collapsed.add(x.id));
    store('gantt-collapsed', [...ui.collapsed]);
    render();
  }
  else if (act === 'team') { ui.team = b.dataset.t; render(); }
  else if (act === 'csv') exportCsv();
  else if (act === 'reload') await reload('Data reloaded.');
  else if (act === 'del') { ui.confirmDel = id; render(); }
  else if (act === 'del2') await deleteTask(id);
  else if (act === 'evdel') { ui.confirmDel = `ev${id}`; render(); }
  else if (act === 'evdel2') await eventWrite(supabase.from('timeline_events').delete().eq('id', id), 'Event deleted.');
  else if (act === 'evadd') {
    const date = document.getElementById('ev-date').value;
    const label = document.getElementById('ev-label').value.trim();
    const note = document.getElementById('ev-note').value.trim() || null;
    if (!date || !label) { toast('Date and label are required.'); return; }
    await eventWrite(supabase.from('timeline_events').insert({ event_date: date, label, note }), 'Event added.');
  }
  else if (act === 'add') {
    const code = document.getElementById('n-code').value.trim();
    const end = document.getElementById('n-end').value;
    const name = document.getElementById('n-name').value.trim();
    const responsible = document.getElementById('n-resp').value.trim() || null;
    const parent = document.getElementById('n-parent').value;
    if (!code || !end || !name) { toast('Code, deadline and activity are required.'); return; }
    await addTask({
      code, name, responsible, end_date: end,
      start_date: iso(dn(end) - DEFAULT_DURATION), duration_days: DEFAULT_DURATION,
      parent_id: parent ? Number(parent) : null,
    });
  }
});

function route() {
  const h = (location.hash || '').slice(1);
  ui.view = VIEWS.some(([k]) => k === h) ? h : 'gantt';
  ui.confirmDel = null;
  render();
}
window.addEventListener('hashchange', route);

/* ---------- start ---------- */
if (profile) {
  try {
    await load();
    route();
  } catch (err) {
    document.getElementById('view').innerHTML = '';
    toast(errorText(err));
  }
}
