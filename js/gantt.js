// Project Gantt: views Gantt, Table, Sub-teams, This week.
// Data in Supabase (tables tasks, task_dependencies). Editing reserved to admins (RLS).
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
let ALL = [];    // derived, ordered
const ui = { view: 'gantt', gteam: 'All', team: 'SYSTEMS', q: '', hideDone: false, open: null, confirmDel: null };

async function load() {
  const [t, d, ev] = await Promise.all([
    supabase.from('tasks').select('*'),
    supabase.from('task_dependencies').select('task_id, depends_on'),
    supabase.from('timeline_events').select('*'),
  ]);
  if (t.error || d.error || ev.error) throw (t.error || d.error || ev.error);
  ROWS = t.data;
  DEPS = d.data;
  EVENTS = ev.data.sort((a, b) => (a.event_date < b.event_date ? -1 : 1));
}

async function reload(message) {
  try { await load(); } catch (err) { toast(errorText(err)); return; }
  render();
  if (message) toast(message);
}

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
      const s = `${t.code} ${t.name} ${t.responsible ?? ''}`.toLowerCase();
      if (!s.includes(q.toLowerCase())) return false;
    }
    return true;
  });
}

/* ---------- write operations (admin) ---------- */
async function patchTask(id, fields) {
  if (!ADMIN) return;
  const { data, error } = await supabase.from('tasks').update(fields).eq('id', id).select().single();
  if (error) { toast(errorText(error)); render(); return; }
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
  let h = `<li>Done<b>${done}/${ts.length}</b></li><li>In progress<b>${work}</b></li>` +
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
  return `<div class="bar-tools">${team}
    <input id="q" type="search" placeholder="Search task or person" value="${esc(ui.q)}" aria-label="Search">
    <label class="chk"><input type="checkbox" id="hd"${ui.hideDone ? ' checked' : ''}> Hide done</label>
    <button type="button" class="secondary" data-act="csv">Export CSV</button>
    <button type="button" class="secondary" data-act="reload">Reload</button>
    <span class="mode">${ADMIN ? 'Changes are saved immediately for the whole team.' : 'Read only: editing reserved to administrators.'}</span>
  </div>`;
}

function legend() {
  return `<ul class="legend">${STATUS.map(([k, l]) => `<li><span class="sw ${k}"></span>${l}</li>`).join('')}
    <li>▲ latest useful start</li><li>→ dependency (dashed: the required task ends after the planned start)</li></ul>`;
}

/* ---------- Gantt view ---------- */
function gantt(all) {
  const ts = filterTasks(all, ui.gteam, ui.q, ui.hideDone);
  if (!ts.length) return toolbar(true) + legend() + '<div class="gwrap"><div class="empty">No task matches these filters.</div></div>';

  const byId = new Map(all.map((t) => [t.id, t]));
  const evDays = EVENTS.map((e) => dn(e.event_date));
  const minStart = Math.min(...all.map((t) => dn(t.start_date)), ...evDays, TN);
  const maxEnd = Math.max(...all.map((t) => dn(t.end_date)), ...evDays, TN);
  const d0 = new Date(minStart * 864e5);
  const d1 = new Date(maxEnd * 864e5);
  const RS = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), 1) / 864e5;
  const RE = Date.UTC(d1.getUTCFullYear(), d1.getUTCMonth() + 1, 0) / 864e5;
  const PX = 7, RH = 30, HH = 56, W = (RE - RS + 1) * PX + 70;
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
    const tip = `${t.code} · ${t.name}\nResponsible: ${t.responsible ?? ''}\nStatus: ${STATUS_LABEL[t.status]}${t.late ? ' (overdue)' : ''}` +
      `\nStart: ${formatDate(t.start_date)} · Deadline: ${formatDate(t.end_date)}` +
      `\nEstimated duration: ${t.duration_days} d · latest useful start: ${formatDate(t.ls)}` +
      (t.parentCode ? `\nSubtask of ${t.parentCode}` : '') + (t.note ? `\n${t.note}` : '');
    const lsx = (dn(t.ls) - RS) * PX + PX / 2;
    rows += `<div class="grow" style="height:${RH}px">
      <div class="glabel${t.depth ? ' sub' : ''}" title="${esc(tip)}"><span class="code">${esc(t.code)}</span><span class="n">${esc(t.name)}</span></div>
      <div class="track" style="width:${W}px">
        <div class="bar ${t.cls}${mile ? ' mile' : ''}${t.hasChildren ? ' parent' : ''}" style="left:${l}px;width:${w}px" title="${esc(tip)}"></div>
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
    <p class="hint">Bars run from the planned start to the deadline. Start dates and durations are effort estimates and are edited in the Table view.</p>`;
}

/* ---------- Table view ---------- */
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
    <td>${input('code', 'text', t.code, 'Code', ' maxlength="20" style="width:80px"')}${requiredByEditor(t)}</td>
    <td>${parentSelect(t)}</td>
    <td>${input('end_date', 'date', t.end_date, 'Deadline')}</td>
    <td>${input('name', 'text', t.name, 'Activity')}${input('note', 'text', t.note ?? '', 'Note', ' class="note-in" placeholder="Note"')}</td>
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
    <td colspan="7"><button type="button" data-act="add">Add task</button></td></tr>`;
  return toolbar(false) +
    `<div class="tw"><table><thead><tr>
      <th>Code and dependants</th><th>Parent</th><th>Deadline</th><th>Activity and note</th><th>Responsible</th><th>Status</th><th>Sub-teams</th>
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
  h += `<div class="tw short"><table><thead><tr><th>Code and dependants</th><th>Deadline</th><th>Activity</th><th>Responsible</th><th>Status</th><th class="x">Start</th><th>Latest start</th></tr></thead><tbody>` +
    ts.map((t) => `<tr class="r-${t.cls}${t.depth ? ' sub' : ''}"><td><span class="code">${esc(t.code)}</span>${reqText(t) ? `<span class="req">${esc(reqText(t))}</span>` : ''}</td>
      <td class="mono">${formatDate(t.end_date)}</td><td>${esc(t.name)}${t.note ? `<br><span class="note">${esc(t.note)}</span>` : ''}</td>
      <td>${esc(t.responsible)}</td><td>${statusSelect(t)}</td><td class="mono x">${formatDate(t.start_date)}</td>
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
      `<tr class="r-${x.cls}"><td style="width:56px"><span class="code">${esc(x.code)}</span></td>
        <td>${esc(x.name)}<span class="req">${esc(x.responsible)}</span></td>
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
  const rows = [['Code', 'Parent', 'Required by', 'Deadline', 'Activity', 'Responsible', 'Status', 'Sub-teams',
    'Start (estimate)', 'Duration (d)', 'Latest start', 'Milestone', 'Note']];
  ALL.forEach((t) => rows.push([t.code, t.parentCode ?? '', t.requiredBy.join(' '), formatDate(t.end_date), t.name,
    t.responsible ?? '', STATUS_LABEL[t.status], t.teams.join(' '), formatDate(t.start_date), t.duration_days,
    formatDate(t.ls), t.milestone_label ?? '', t.note ?? '']));
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\r\n');
  download(`gantt_${TODAY}.csv`, `﻿${csv}`, 'text/csv');
}

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
    else if (!render.done && ui.ganttStart != null) { gw.scrollLeft = Math.max(0, (TN - ui.ganttStart) * 7 - 40); }
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
  const b = e.target.closest?.('[data-act]');
  if (!b) return;
  const act = b.dataset.act, id = Number(b.dataset.id);
  if (act === 'team') { ui.team = b.dataset.t; render(); }
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
