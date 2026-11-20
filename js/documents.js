// Documents: register, documents required per milestone, review queue.
// Data in Supabase (migration 010): documents, document_versions,
// document_requirements, milestones, document_history.
// File names follow the J2050 Documentation Manual: [SUBTEAM]_[TYPE]_[Title]_VXX.
// Rights (enforced by the database):
//   document managers = admins and the leader of the SYS sub-team (team_leaders);
//   new document: document managers and teamleaders (a teamleader becomes the responsible);
//   document, versions and requirements: the responsible and document managers;
//   responsible, deletion and milestones: document managers; approval: admins.
import { supabase } from './config.js';
import { initProtectedPage, friendlyError } from './auth.js';
import { formatDate, formatDateTime, todayIso } from './format.js';

/* ---------- constants ---------- */
const SUBTEAMS = ['SYS', 'ELE', 'SFW', 'AOCS', 'THS', 'TTC', 'OUT', 'MGT', 'RED'];
const SUBTEAM_NAMES = {
  SYS: 'Systems', ELE: 'Electronics', SFW: 'Software', AOCS: 'AOCS', THS: 'Thermostructure',
  TTC: 'Telecommunications', OUT: 'Outreach', MGT: 'Management', RED: 'Whole team / RedPill',
};
const TYPES = {
  REQ: 'Requirements', DREP: 'Design Report', DS: 'Datasheet', AREP: 'Analysis Report',
  TPLN: 'Test Plan', TSTP: 'Test Specification and Procedures', PROC: 'Procedure',
  TREP: 'Test Report', NCR: 'Non-Conformance Report', RFD: 'Request for Deviation',
  RFW: 'Request for Waiver', VCD: 'Verification Control Document', MAN: 'Manual', LOG: 'Logbook', PLAN: 'Plan',
  PUR: 'Purchase', PRES: 'Presentation', TEMP: 'Template', CAD: 'Mechanical CAD', ECAD: 'Electrical CAD',
};
const VSTATUS = {
  none: 'Not started',
  in_progress: 'In progress',
  in_review: 'In review',
  approved: 'Approved',
  sent: 'Sent to ESA',
  esa_accepted: 'Accepted by ESA',
  esa_changes: 'ESA changes required',
};
const LEVELS = { draft: ['◌', 'Draft'], release: ['●', 'Release'], update: ['⊗', 'Update'], ad_hoc: ['AH', 'Ad hoc'] };
const RSTATE = {
  done: 'Delivered', changes: 'Delivered, ESA changes required', waived: 'Waived',
  late: 'Late', soon: 'Due soon', open: 'To deliver', adhoc: 'Ad hoc',
};
const VIEWS = [['register', 'Register'], ['milestones', 'Milestones'], ['review', 'Review']];
const SOON_DAYS = 21;
const SENT = ['sent', 'esa_accepted', 'esa_changes'];

/* ---------- utilities ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TODAY = todayIso();
const daysTo = (d) => Math.round((Date.parse(d) - Date.parse(TODAY)) / 864e5);
const vv = (n) => `V${String(n).padStart(2, '0')}`;
const $ = (sel, root = document) => root.querySelector(sel);
const val = (id) => ($(`#${id}`)?.value ?? '').trim();
const stored = (key, fallback) => { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } };
const store = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } };
const link = (url, text) => (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>` : '');

function toast(message) {
  const t = document.getElementById('toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toast.h);
  toast.h = setTimeout(() => { t.hidden = true; }, 5000);
}

const ERRORS = {
  'Not authorized': 'Operation not allowed: only the responsible of the document, the Systems leader and the administrators can do it.',
  'Responsible shall be an active teamleader or admin': 'The responsible shall be an active member with role teamleader or admin.',
  'File name cannot be changed after a release': 'Subteam, type and title cannot change after the first approved version.',
  'Document modified by someone else': 'The document has been modified by someone else in the meantime: reload and repeat the change.',
  'Document not found': 'The document no longer exists: reload the page.',
  'Previous version not released': 'The last version is still in progress or in review.',
  'Version limit reached': 'Version V99 reached.',
  'Version number out of range': 'The version number shall be between 0 and 99.',
  'Version number can be chosen only for the first version': 'The document already has versions: the new one takes the next number.',
  'Version not found': 'The version no longer exists: reload the page.',
  'Released version cannot be changed': 'An approved version cannot be changed: start a new version.',
  'Version not in progress': 'The version is not in progress.',
  'Version not in review': 'The version is not in review.',
  'Version not approved': 'The version has not been approved yet.',
  'File link required': 'Give the link to the PDF of the version.',
  'Note required': 'Explain what has to be changed.',
  'ESA link required': 'Give the link to the copy on the ESA SharePoint.',
  'ESA comments required': 'Report the comments of ESA.',
  'Requirement of another document': 'The selected milestone does not belong to this document.',
  'Version of another document': 'The version belongs to another document.',
  'Version not sent to ESA': 'Only a version sent to ESA can fulfil a requirement.',
  'Only versions in progress can be deleted': 'Only a version in progress can be deleted.',
  'Only the last version can be deleted': 'Only the last version can be deleted.',
  'Actual dates cannot be in the future': 'The date cannot be in the future.',
};
function errorText(error) {
  const m = error?.message ?? String(error);
  if (/documents_subteam_doc_type_title_key/.test(m)) return 'A document with this file name already exists.';
  if (/documents_title_check/.test(m)) return 'Title: PascalCase, letters and digits only, no spaces (e.g. LinkBudget).';
  if (/documents_name_check/.test(m)) return 'Give the full name of the document.';
  if (/documents_check/.test(m)) return 'Give the reason why the document is on hold.';
  if (/milestones_code_key/.test(m)) return 'A milestone with this code already exists.';
  if (/milestones_code_check/.test(m)) return 'Code: capital letters, digits and hyphens, at most 16 characters.';
  if (/milestones_name_check/.test(m)) return 'Give the name of the milestone.';
  if (/milestones_check/.test(m)) return 'The data package cannot be due after the review.';
  if (/document_requirements_milestone_id_document_id_key/.test(m)) return 'The document is already required at this milestone.';
  if (/document_requirements_check/.test(m)) return 'Give the reason of the waiver.';
  return ERRORS[m] ?? friendlyError(error);
}

/* ---------- state ---------- */
const profile = await initProtectedPage('documents');
const ME = profile?.id;
const ADMIN = profile?.role === 'admin';
let MANAGER = ADMIN;       // admin or leader of SYS (set by load)
let CAN_CREATE = ADMIN || profile?.role === 'teamleader';
let DOCS = [];
let VERS = new Map();      // document id -> versions, last first
let VBYID = new Map();
let REQS = [];
let MILES = [];
let MBYID = new Map();
let TASKS = new Map();
let PEOPLE = new Map();
const ui = {
  view: VIEWS.some(([k]) => k === stored('docs-view', 'register')) ? stored('docs-view', 'register') : 'register',
  // Filters remembered in this browser
  q: '',
  sub: ['All', ...SUBTEAMS].includes(stored('docs-sub', 'All')) ? stored('docs-sub', 'All') : 'All',
  status: ['All', ...Object.keys(VSTATUS), 'on_hold'].includes(stored('docs-status', 'All')) ? stored('docs-status', 'All') : 'All',
  mine: stored('docs-mine', false) === true,
  gaps: stored('docs-gaps', false) === true,
};

async function load() {
  const [d, v, r, m, t, p, l] = await Promise.all([
    supabase.from('documents').select('*'),
    supabase.from('document_versions').select('*'),
    supabase.from('document_requirements').select('*'),
    supabase.from('milestones').select('*'),
    supabase.from('tasks').select('id, code, name, start_date, end_date, deadline, completed_on'),
    supabase.from('profiles').select('id, full_name, email, role, status'),
    supabase.from('team_leaders').select('team, leader_id'),
  ]);
  const error = d.error || v.error || r.error || m.error || t.error || p.error || l.error;
  if (error) throw error;
  PEOPLE = new Map(p.data.map((x) => [x.id, { name: x.full_name ?? x.email, role: x.role, status: x.status }]));
  MANAGER = ADMIN || (l.data.some((x) => x.team === 'SYS' && x.leader_id === ME) && validLeader(ME));
  CAN_CREATE = MANAGER || profile?.role === 'teamleader';
  TASKS = new Map(t.data.map((x) => [x.id, x]));
  MILES = m.data.sort((a, b) => a.sort_order - b.sort_order || a.code.localeCompare(b.code));
  MBYID = new Map(MILES.map((x) => [x.id, x]));
  VBYID = new Map(v.data.map((x) => [x.id, x]));
  VERS = new Map();
  v.data.sort((a, b) => b.version - a.version).forEach((x) => {
    if (!VERS.has(x.document_id)) VERS.set(x.document_id, []);
    VERS.get(x.document_id).push(x);
  });
  const order = new Map(MILES.map((x, i) => [x.id, i]));
  REQS = r.data.sort((a, b) => order.get(a.milestone_id) - order.get(b.milestone_id));
  DOCS = d.data.sort((a, b) => baseName(a).localeCompare(baseName(b)));
}

async function reload(message) {
  try { await load(); } catch (err) { toast(errorText(err)); return false; }
  render();
  if (message) toast(message);
  return true;
}

/* ---------- people ---------- */
const validLeader = (id) => {
  const p = id ? PEOPLE.get(id) : null;
  return Boolean(p && p.status === 'active' && (p.role === 'teamleader' || p.role === 'admin'));
};
const eligibleLeaders = () => [...PEOPLE.entries()].filter(([id]) => validLeader(id))
  .sort((a, b) => a[1].name.localeCompare(b[1].name));
const nameOf = (id) => (id ? PEOPLE.get(id)?.name ?? '?' : '');

/* ---------- derived model ---------- */
const baseName = (d) => `${d.subteam}_${d.doc_type}_${d.title}`;
const versionsOf = (d) => VERS.get(d.id) ?? [];
const lastVersion = (d) => versionsOf(d)[0] ?? null;
const docStatus = (d) => lastVersion(d)?.status ?? 'none';
const canEdit = (d) => MANAGER || d.responsible_id === ME;
const inWork = (v) => v && (v.status === 'in_progress' || v.status === 'in_review');
// Last released version (approved or sent to ESA): its PDF is the current issue
const releasedOf = (d) => versionsOf(d).find((v) => !inWork(v)) ?? null;
const quickLinks = (d) => {
  const rel = releasedOf(d);
  return [link(d.working_url, 'Edit'), rel ? link(rel.file_url, `PDF ${vv(rel.version)}`) : '', link(d.folder_url, 'Folder')]
    .filter(Boolean).join(' · ');
};
// Name of the file being prepared (last version in work) or of the next one
const workingName = (d) => {
  const last = lastVersion(d);
  return `${baseName(d)}_${vv(!last ? 0 : inWork(last) ? last.version : last.version + 1)}`;
};
const reqsOf = (d) => REQS.filter((r) => r.document_id === d.id);
const dueOf = (m) => m?.docs_due ?? m?.review_date ?? null;

function reqState(r) {
  if (r.waived) return 'waived';
  if (r.version_id) return VBYID.get(r.version_id)?.status === 'esa_changes' ? 'changes' : 'done';
  if (r.level === 'ad_hoc') return 'adhoc';
  const due = dueOf(MBYID.get(r.milestone_id));
  if (due && due < TODAY) return 'late';
  if (due && daysTo(due) <= SOON_DAYS) return 'soon';
  return 'open';
}
const isOpen = (r) => ['late', 'soon', 'open'].includes(reqState(r));

// Coverage by the Gantt: a task should produce each open requirement before the data package is due
function reqRisk(r) {
  if (!isOpen(r)) return null;
  const t = r.task_id ? TASKS.get(r.task_id) : null;
  if (!t) return 'No task in the Gantt';
  const due = dueOf(MBYID.get(r.milestone_id));
  const end = t.deadline ?? t.end_date;
  if (due && !t.completed_on && end > due) return `Task ${t.code} ends after the data package is due`;
  return null;
}
const nextReq = (d) => reqsOf(d).find(isOpen) ?? null;

/* ---------- rendering ---------- */
function renderNav() {
  $('#d-nav').innerHTML = VIEWS.map(([k, label]) =>
    `<a href="#${k}"${ui.view === k ? ' aria-current="page"' : ''}>${label}</a>`).join('');
}

function renderStats() {
  const open = REQS.filter(isOpen);
  const late = open.filter((r) => reqState(r) === 'late').length;
  const review = [...VBYID.values()].filter((v) => v.status === 'in_review').length;
  const next = MILES.find((m) => !m.held_on && dueOf(m) && dueOf(m) >= TODAY);
  let h = `<li>Documents<b>${DOCS.length}</b></li>`;
  h += `<li>To approve<b>${review}</b></li>`;
  h += `<li>Late deliveries<b class="${late ? 'bad' : ''}">${late}</b></li>`;
  if (next) h += `<li>Days to ${esc(next.code)} data package<b>${daysTo(dueOf(next))}</b></li>`;
  $('#stats').innerHTML = h;
}

function render() {
  renderNav();
  renderStats();
  const v = $('#view');
  if (ui.view === 'register') v.innerHTML = viewRegister();
  else if (ui.view === 'milestones') v.innerHTML = viewMilestones();
  else v.innerHTML = viewReview();
  bindTools();
  fillList();
}

function fillList() {
  const list = $('#list');
  if (!list) return;
  if (ui.view === 'register') list.innerHTML = registerTable();
  else if (ui.view === 'milestones') list.innerHTML = matrixTable();
}

const subOptions = (sel, all = true) => (all ? `<option value="All">All subteams</option>` : '') +
  SUBTEAMS.map((s) => `<option value="${s}"${sel === s ? ' selected' : ''}>${s} – ${esc(SUBTEAM_NAMES[s])}</option>`).join('');

function filterDocs() {
  const q = ui.q.toLowerCase();
  return DOCS.filter((d) => {
    if (ui.sub !== 'All' && d.subteam !== ui.sub && !d.subteams.includes(ui.sub)) return false;
    if (ui.mine && d.responsible_id !== ME) return false;
    if (ui.view === 'register' && ui.status !== 'All') {
      if (ui.status === 'on_hold' ? !d.on_hold : docStatus(d) !== ui.status) return false;
    }
    if (ui.view === 'milestones' && ui.gaps && !reqsOf(d).some((r) => isOpen(r) && (reqState(r) !== 'open' || reqRisk(r)))) return false;
    if (q && !`${baseName(d)} ${d.name} ${d.esa_code ?? ''} ${nameOf(d.responsible_id)}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function toolsHtml(extra) {
  return `<div class="bar-tools">
    <input id="f-q" type="search" placeholder="Search name, ESA code, responsible" value="${esc(ui.q)}" aria-label="Search">
    <select id="f-sub" aria-label="Subteam">${subOptions(ui.sub)}</select>
    ${extra}
    <label class="chk"><input id="f-mine" type="checkbox"${ui.mine ? ' checked' : ''}> My documents</label>
    ${CAN_CREATE ? '<button id="new-doc" type="button" class="secondary">New document</button>' : ''}
  </div>`;
}

function bindTools() {
  const on = (id, ev, fn) => $(`#${id}`)?.addEventListener(ev, fn);
  on('f-q', 'input', (e) => { ui.q = e.target.value; fillList(); });
  on('f-sub', 'change', (e) => { ui.sub = e.target.value; store('docs-sub', ui.sub); fillList(); });
  on('f-status', 'change', (e) => { ui.status = e.target.value; store('docs-status', ui.status); fillList(); });
  on('f-mine', 'change', (e) => { ui.mine = e.target.checked; store('docs-mine', ui.mine); fillList(); });
  on('f-gaps', 'change', (e) => { ui.gaps = e.target.checked; store('docs-gaps', ui.gaps); fillList(); });
  on('new-doc', 'click', () => openDoc(null));
  on('new-ms', 'click', () => openMilestone(null));
}

const statusBadge = (s) => `<span class="st ds-${s}">${esc(VSTATUS[s])}</span>`;
const levelSym = (l) => `<span class="lv" title="${LEVELS[l][1]}">${LEVELS[l][0]}</span>`;

/* ----- Register ----- */
function viewRegister() {
  const opts = ['All', ...Object.keys(VSTATUS), 'on_hold'].map((k) =>
    `<option value="${k}"${ui.status === k ? ' selected' : ''}>${k === 'All' ? 'All statuses' : k === 'on_hold' ? 'On hold' : VSTATUS[k]}</option>`).join('');
  return toolsHtml(`<select id="f-status" aria-label="Status">${opts}</select>`) + '<div id="list"></div>';
}

function registerTable() {
  const docs = filterDocs();
  if (!docs.length) return '<p class="empty">No documents.</p>';
  const rows = docs.map((d) => {
    const r = nextReq(d);
    const m = r ? MBYID.get(r.milestone_id) : null;
    const due = dueOf(m);
    const st = r ? reqState(r) : null;
    const risk = r ? reqRisk(r) : null;
    return `<tr data-open="${d.id}" tabindex="0">
      <td class="mono">${esc(workingName(d))}</td>
      <td>${esc(d.name)}${d.on_hold ? ' <span class="st blocked">On hold</span>' : ''}</td>
      <td class="mono">${esc(d.esa_code ?? '')}</td>
      <td>${esc(nameOf(d.responsible_id)) || '<span class="bad">none</span>'}</td>
      <td>${statusBadge(docStatus(d))}</td>
      <td class="links">${quickLinks(d)}</td>
      <td>${r ? `${levelSym(r.level)} ${esc(m.code)} <span class="${st === 'late' ? 'bad' : st === 'soon' ? 'warn' : ''}">${due ? formatDate(due) : 'date to set'}</span>${risk ? ` <span class="flag" title="${esc(risk)}">!</span>` : ''}` : ''}</td>
    </tr>`;
  }).join('');
  return `<div class="tw"><table class="ro">
    <thead><tr><th>File name</th><th>Document</th><th>ESA</th><th>Responsible</th><th>Status</th><th>Links</th><th>Next delivery</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <p class="hint">${docs.length} documents. "!" = delivery not covered by a task of the Gantt, or task ending after the data package is due.</p>`;
}

/* ----- Milestones matrix ----- */
function viewMilestones() {
  return toolsHtml(`<label class="chk"><input id="f-gaps" type="checkbox"${ui.gaps ? ' checked' : ''}> Only problems</label>
      ${MANAGER ? '<button id="new-ms" type="button" class="secondary">New milestone</button>' : ''}`) +
    `<ul class="legend">
      ${Object.entries(LEVELS).map(([, [s, l]]) => `<li><b>${s}</b> ${l}</li>`).join('')}
      ${['done', 'changes', 'late', 'soon', 'open', 'waived'].map((k) => `<li><span class="sw rq-${k}"></span>${RSTATE[k]}</li>`).join('')}
      <li><span class="flag">!</span> Not covered by the Gantt</li>
    </ul><div id="list"></div>`;
}

function milestoneHead(m) {
  const due = dueOf(m);
  const cls = m.held_on ? 'held' : due && due < TODAY ? 'bad' : '';
  return `<th class="ms ${cls}"${MANAGER ? ` data-ms="${m.id}" tabindex="0" title="Edit milestone"` : ''}>
    <span class="code">${esc(m.code)}</span>${m.phase ? ` <small>${esc(m.phase)}</small>` : ''}
    <span class="req">${m.docs_due ? `Docs ${formatDate(m.docs_due)}` : 'Docs: date to set'}</span>
    <span class="req">${m.held_on ? `Held ${formatDate(m.held_on)}` : m.review_date ? `Review ${formatDate(m.review_date)}` : ''}</span>
  </th>`;
}

function matrixTable() {
  if (!MILES.length) return '<p class="empty">No milestones.</p>';
  const docs = filterDocs();
  const byKey = new Map(REQS.map((r) => [`${r.document_id}:${r.milestone_id}`, r]));
  const rows = docs.map((d) => `<tr>
      <th class="dn" data-open="${d.id}" tabindex="0"><span class="mono">${esc(baseName(d))}</span><span class="req">${esc(d.esa_code ?? '')} ${esc(nameOf(d.responsible_id))}</span></th>
      ${MILES.map((m) => {
        const r = byKey.get(`${d.id}:${m.id}`);
        if (!r) return canEdit(d) ? `<td class="cell"><button type="button" class="rq add" data-add="${d.id}:${m.id}" title="Require at ${esc(m.code)}">+</button></td>` : '<td class="cell"></td>';
        const st = reqState(r);
        const risk = reqRisk(r);
        const v = r.version_id ? VBYID.get(r.version_id) : null;
        const t = r.task_id ? TASKS.get(r.task_id) : null;
        const tip = [`${LEVELS[r.level][1]} – ${RSTATE[st]}`, v ? `by ${vv(v.version)}` : '', t ? `Task ${t.code} ${t.name}` : '', risk ?? '', r.note ?? ''].filter(Boolean).join('\n');
        return `<td class="cell"><button type="button" class="rq rq-${st}" data-req="${r.id}" title="${esc(tip)}">${LEVELS[r.level][0]}${v ? `<small>${vv(v.version)}</small>` : ''}${risk ? '<span class="flag">!</span>' : ''}</button></td>`;
      }).join('')}
    </tr>`).join('');
  const foot = MILES.map((m) => {
    const rs = REQS.filter((r) => r.milestone_id === m.id && r.level !== 'ad_hoc' && !r.waived);
    const done = rs.filter((r) => r.version_id).length;
    const noTask = rs.filter((r) => isOpen(r) && !r.task_id).length;
    const risk = rs.filter((r) => isOpen(r) && r.task_id && reqRisk(r)).length;
    return `<td class="cell foot"><b>${done}/${rs.length}</b><span class="req">delivered</span>
      ${noTask ? `<span class="req bad">${noTask} without task</span>` : ''}${risk ? `<span class="req bad">${risk} task late</span>` : ''}</td>`;
  }).join('');
  return `<div class="tw mx"><table>
    <thead><tr><th class="dn">Document</th>${MILES.map(milestoneHead).join('')}</tr></thead>
    <tbody>${rows || `<tr><td colspan="${MILES.length + 1}" class="empty">No documents.</td></tr>`}</tbody>
    <tfoot><tr><th class="dn">Coverage</th>${foot}</tr></tfoot>
  </table></div>`;
}

/* ----- Review ----- */
function viewReview() {
  const vers = [...VBYID.values()];
  const docOf = (v) => DOCS.find((d) => d.id === v.document_id);
  const vrow = (v, extra = '') => {
    const d = docOf(v);
    return `<tr data-open="${d.id}" tabindex="0"><td class="mono">${esc(baseName(d))}_${vv(v.version)}</td>
      <td>${esc(d.name)}</td><td>${esc(nameOf(d.responsible_id))}</td><td>${extra}</td></tr>`;
  };
  const table = (title, rows, head) => `<h2 class="g-h2">${title} <small>${rows.length}</small></h2>` +
    (rows.length ? `<div class="tw short"><table class="ro"><thead><tr><th>File</th><th>Document</th><th>Responsible</th><th>${head}</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '<p class="hint">Nothing.</p>');
  const inReview = vers.filter((v) => v.status === 'in_review')
    .map((v) => vrow(v, `${formatDateTime(v.submitted_at)} by ${esc(nameOf(v.submitted_by))}`));
  const toSend = vers.filter((v) => v.status === 'approved')
    .map((v) => vrow(v, `Approved ${formatDate(v.approved_at)}`));
  const changes = vers.filter((v) => v.status === 'esa_changes' && (lastVersion(docOf(v))?.id === v.id))
    .map((v) => vrow(v, esc(v.esa_comments ?? '')));
  const due = REQS.filter((r) => ['late', 'soon'].includes(reqState(r))).map((r) => {
    const d = DOCS.find((x) => x.id === r.document_id);
    const m = MBYID.get(r.milestone_id);
    return `<tr data-open="${d.id}" tabindex="0"><td class="mono">${esc(baseName(d))}</td><td>${esc(d.name)}</td>
      <td>${esc(nameOf(d.responsible_id))}</td>
      <td>${levelSym(r.level)} ${esc(m.code)} <span class="${reqState(r) === 'late' ? 'bad' : 'warn'}">${formatDate(dueOf(m))}</span> ${statusBadge(docStatus(d))}</td></tr>`;
  });
  return table('Waiting for approval', inReview, 'Submitted') +
    table('Approved, to send to ESA', toSend, 'Approved') +
    table('ESA changes required', changes, 'ESA comments') +
    table(`Deliveries late or due within ${SOON_DAYS} days`, due, 'Milestone');
}

/* ---------- modal ---------- */
const modal = () => $('#d-modal');
function showModal(html, wide = true) {
  const m = modal();
  m.innerHTML = `<div class="mbox${wide ? ' wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  m.hidden = false;
  m.dirty = false;
  m.querySelector('input, select, textarea, button')?.focus();
}
function closeModal() {
  modal().hidden = true;
  modal().innerHTML = '';
  modal().dirty = false;
  history.replaceState(null, '', `#${ui.view}`);
}
// Close asked by the user (Close, Esc, click outside): confirm when something was typed
function requestClose() {
  if (modal().dirty && !confirm('Discard the unsaved changes?')) return false;
  closeModal();
  return true;
}
// Error shown in the dialog, next to the buttons that caused it (toast if there is no place)
function showError(text, where) {
  const el = where ? modal().querySelector(where) : null;
  if (!el) { toast(text); return; }
  el.textContent = text;
  el.className = 'message error';
  el.hidden = false;
  el.scrollIntoView({ block: 'nearest' });
}

async function run(promise, okMessage, where) {
  const { data, error } = await promise;
  if (error) { showError(errorText(error), where); return { ok: false }; }
  modal().dirty = false;
  await reload(okMessage);
  return { ok: true, data };
}

/* ----- Document ----- */
function openDoc(id) {
  const d = id == null ? null : DOCS.find((x) => x.id === id);
  if (id != null && !d) { toast('The document no longer exists.'); return; }
  if (d) history.replaceState(null, '', `#doc=${d.id}`);
  const edit = d ? canEdit(d) : CAN_CREATE;
  const dis = edit ? '' : ' disabled';
  const locked = d && versionsOf(d).some((v) => !inWork(v));
  const v = d ?? { subteam: 'SYS', doc_type: 'DREP', title: '', name: '', subteams: [], priority: null, on_hold: false };
  const respField = MANAGER
    ? `<select id="e-resp"><option value="">— none —</option>${eligibleLeaders().map(([pid, p]) =>
      `<option value="${pid}"${v.responsible_id === pid ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`
    : `<input value="${esc(d ? nameOf(d.responsible_id) || 'none' : 'You')}" disabled>`;
  const typeOpts = Object.entries(TYPES).map(([k, n]) => `<option value="${k}"${v.doc_type === k ? ' selected' : ''}>${k} – ${esc(n)}</option>`).join('');

  let html = `<h2>${d ? `<span class="mono">${esc(workingName(d))}</span>` : 'New document'}
      ${d ? `<button type="button" class="act secondary" id="copy-name" title="Copy the file name">Copy name</button>` : ''}</h2>
    <p class="meta">${d ? `${statusBadge(docStatus(d))} Responsible: ${esc(nameOf(d.responsible_id) || 'none')} · last change ${formatDateTime(d.updated_at)}${quickLinks(d) ? ` · ${quickLinks(d)}` : ''}` : 'File name: [SUBTEAM]_[TYPE]_[Title]_VXX (J2050 Documentation Manual).'}</p>
    <div class="ed-grid">
      <div><label for="e-sub">Subteam</label><select id="e-sub"${dis || (locked ? ' disabled' : '')}>${subOptions(v.subteam, false)}</select></div>
      <div><label for="e-type">Type</label><select id="e-type"${dis || (locked ? ' disabled' : '')}>${typeOpts}</select></div>
      <div><label for="e-title">Title (PascalCase)</label><input id="e-title" maxlength="60" placeholder="LinkBudget" value="${esc(v.title)}"${dis || (locked ? ' disabled' : '')}></div>
      <div class="span2"><label for="e-name">Full name</label><input id="e-name" maxlength="120" value="${esc(v.name)}"${dis}></div>
      <div><label for="e-esa">ESA code</label><input id="e-esa" maxlength="20" placeholder="e.g. TS-VCD" value="${esc(v.esa_code ?? '')}"${dis}></div>
      <div><label for="e-resp">Responsible</label>${respField}</div>
      <div><label for="e-prio">Priority</label><select id="e-prio"${dis}><option value="">—</option>${['low', 'medium', 'high'].map((p) => `<option${v.priority === p ? ' selected' : ''}>${p}</option>`).join('')}</select></div>
      <div></div>
      <div class="span3"><label for="e-folder">Folder (SharePoint)</label><input id="e-folder" type="url" value="${esc(v.folder_url ?? '')}"${dis}></div>
      <div class="span3"><label for="e-work">Working file (Word, Excel…)</label><input id="e-work" type="url" value="${esc(v.working_url ?? '')}"${dis}></div>
      <div class="span3"><span class="lbl">Other subteams involved</span><div class="ed-teams">${SUBTEAMS.map((s) =>
        `<label class="pk"><input type="checkbox" name="e-subs" value="${s}"${v.subteams.includes(s) ? ' checked' : ''}${dis}> ${s}</label>`).join('')}</div></div>
      <div class="span3"><label for="e-people">People working on it</label><input id="e-people" value="${esc(v.people ?? '')}"${dis}></div>
      <div class="span3"><label class="pk chk"><input id="e-hold" type="checkbox"${v.on_hold ? ' checked' : ''}${dis}> On hold</label>
        <input id="e-hold-reason" placeholder="Reason" value="${esc(v.on_hold_reason ?? '')}"${dis}${v.on_hold ? '' : ' hidden'}></div>
      <div class="span3"><label for="e-note">Note</label><textarea id="e-note" rows="2"${dis}>${esc(v.note ?? '')}</textarea></div>
      ${locked && edit ? '<p class="span3 hint">Subteam, type and title are fixed after the first approved version.</p>' : ''}
    </div>
    <p class="message" id="d-msg" role="alert" hidden></p>
    <div class="buttons">
      ${d && MANAGER ? '<button type="button" class="danger" id="e-del">Delete document</button>' : ''}
      <span class="spacer"></span><button type="button" class="secondary" data-close>Close</button>
      ${edit ? `<button type="button" id="e-save">${d ? 'Save' : 'Create'}</button>` : ''}
    </div>`;
  if (d) html += versionsHtml(d) + requirementsHtml(d) + `<details class="ed-hist" id="e-hist"><summary>History</summary><ul class="hist"><li>Loading…</li></ul></details>`;
  showModal(html);

  const m = modal();
  m.querySelector('#e-hold')?.addEventListener('change', (e) => { $('#e-hold-reason').hidden = !e.target.checked; });
  m.querySelector('#copy-name')?.addEventListener('click', () => copy(workingName(d)));
  m.querySelector('#e-save')?.addEventListener('click', () => saveDoc(d));
  m.querySelector('#e-del')?.addEventListener('click', async () => {
    if (!confirm(`Delete ${baseName(d)} with all its versions and requirements? This cannot be undone.`)) return;
    const r = await run(supabase.from('documents').delete().eq('id', d.id), 'Document deleted.', '#d-msg');
    if (r.ok) closeModal();
  });
  if (d) bindVersions(d);
  m.querySelector('#e-hist')?.addEventListener('toggle', (e) => { if (e.target.open) loadHistory(d); }, { once: true });
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast(`Copied: ${text}`); } catch { toast(text); }
}

async function saveDoc(d) {
  const fields = {
    subteam: $('#e-sub').value, doc_type: $('#e-type').value, title: val('e-title'), name: val('e-name'),
    esa_code: val('e-esa'), responsible_id: MANAGER ? $('#e-resp').value : (d?.responsible_id ?? ''),
    priority: $('#e-prio').value, folder_url: val('e-folder'), working_url: val('e-work'), people: val('e-people'),
    subteams: [...document.querySelectorAll('input[name="e-subs"]:checked')].map((x) => x.value),
    on_hold: $('#e-hold').checked, on_hold_reason: val('e-hold-reason'), note: val('e-note'),
  };
  if (!fields.title || !fields.name) { showError('Give title and full name.', '#d-msg'); return; }
  const r = await run(supabase.rpc('doc_save', { p_id: d?.id ?? null, p_fields: fields, p_expected: d?.updated_at ?? null }),
    d ? 'Document saved.' : 'Document created.', '#d-msg');
  if (r.ok) openDoc(r.data);
}

/* ----- Versions ----- */
function versionsHtml(d) {
  const vers = versionsOf(d);
  const last = vers[0];
  const edit = canEdit(d);
  const rows = vers.map((v) => {
    const acts = edit ? versionActions(v, v === last) : [];
    return `<tr>
      <td class="mono">${vv(v.version)}${v !== last ? ' <span class="req">old</span>' : ''}</td>
      <td>${statusBadge(v.status)}</td>
      <td>${link(v.file_url, 'PDF')}${v.esa_url ? ` · ${link(v.esa_url, 'ESA copy')}` : ''}</td>
      <td>${v.change_note ? esc(v.change_note) : ''}
        ${v.review_note && v.status === 'in_progress' ? `<span class="req bad">To change: ${esc(v.review_note)}</span>` : ''}
        ${v.esa_comments ? `<span class="req">ESA: ${esc(v.esa_comments)}</span>` : ''}
        ${v.sent_on ? `<span class="req">Sent ${formatDate(v.sent_on)}</span>` : ''}
        ${v.approved_at ? `<span class="req">Approved ${formatDate(v.approved_at)} by ${esc(nameOf(v.approved_by))}</span>` : ''}</td>
      <td class="actions">${acts.map(([a, label, cls]) => `<button type="button" class="act ${cls ?? 'secondary'}" data-vact="${a}" data-v="${v.id}">${label}</button>`).join(' ')}</td>
    </tr>`;
  }).join('');
  const canNew = edit && !inWork(last);
  return `<h3>Versions</h3>
    ${vers.length ? `<div class="tw short"><table><thead><tr><th>Version</th><th>Status</th><th>Links</th><th>Notes</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="hint">No version yet.</p>'}
    ${canNew ? `<div class="buttons"><button type="button" class="secondary" id="v-new">${last ? `Start ${vv(last.version + 1)}` : 'Start first version'}</button></div>` : ''}
    <div id="v-panel"></div>`;
}

function versionActions(v, isLast) {
  const a = [];
  switch (v.status) {
    case 'in_progress': a.push(['edit', 'Edit'], ['submit', 'Submit for review', 'primary']); break;
    case 'in_review':
      a.push(['withdraw', 'Withdraw']);
      if (ADMIN) a.push(['approve', 'Approve', 'primary'], ['return', 'Return']);
      break;
    case 'approved': a.push(['send', 'Mark as sent to ESA…', 'primary']); break;
    default: a.push(['esa', 'ESA outcome…']);
  }
  if (ADMIN && v.status !== 'in_progress' && v.status !== 'in_review') a.push(['reset', 'Reset']);
  if (isLast && v.status === 'in_progress') a.push(['delete', 'Delete', 'danger']);
  return a;
}

function bindVersions(d) {
  const m = modal();
  m.querySelector('#v-new')?.addEventListener('click', () => versionPanel(d, null, 'new'));
  m.querySelectorAll('[data-vact]').forEach((b) => b.addEventListener('click', () =>
    versionPanel(d, VBYID.get(Number(b.dataset.v)), b.dataset.vact)));
}

// Form of an action on a version, below the list of versions
function versionPanel(d, v, action) {
  const p = $('#v-panel');
  const name = v ? `${baseName(d)}_${vv(v.version)}` : workingName(d);
  const openReqs = reqsOf(d).filter((r) => !r.waived && !r.version_id);
  const confirmOnly = { withdraw: 'Withdraw the version from the review?', approve: 'Approve the version?',
    reset: 'Bring the version back to "In progress"? The milestones lose the link to this version.',
    delete: 'Delete the version?' };
  let body = '';
  if (action === 'new') {
    const first = !versionsOf(d).length;
    body = `<div class="ed-grid">
      ${first ? '<div><label for="p-num">Version number</label><input id="p-num" type="number" min="0" max="99" step="1" value="0"></div><div class="span2"></div>' : ''}
      <div class="span3"><label for="p-file">Link to the PDF (optional)</label><input id="p-file" type="url"></div>
      <div class="span3"><label for="p-change">What changes in this version</label><input id="p-change"></div></div>`;
  } else if (action === 'edit' || action === 'submit') {
    body = `<div class="ed-grid"><div class="span3"><label for="p-file">Link to the PDF</label><input id="p-file" type="url" value="${esc(v.file_url ?? '')}"></div>
      ${action === 'edit' ? `<div class="span3"><label for="p-change">What changes in this version</label><input id="p-change" value="${esc(v.change_note ?? '')}"></div>` : ''}</div>
      ${action === 'submit' ? '<p class="hint">An administrator reviews this PDF. Once approved, the version and its PDF cannot be changed: changes go in the next version.</p>' : ''}`;
  } else if (action === 'return') {
    body = `<label for="p-note">What has to be changed</label><textarea id="p-note" rows="3"></textarea>`;
  } else if (action === 'send') {
    body = `<div class="ed-grid"><div><label for="p-sent">Sent on</label><input id="p-sent" type="date" max="${TODAY}" value="${TODAY}"></div>
      <div class="span2"><label for="p-esa">Link to the copy on the ESA SharePoint</label><input id="p-esa" type="url"></div>
      <div class="span3"><span class="lbl">Milestones fulfilled by this version</span>${openReqs.length ? openReqs.map((r, i) => {
        const ms = MBYID.get(r.milestone_id);
        return `<label class="pk"><input type="checkbox" name="p-req" value="${r.id}"${i === 0 ? ' checked' : ''}> ${esc(ms.code)} – ${LEVELS[r.level][1]}</label>`;
      }).join('') : '<p class="hint">No open milestone for this document.</p>'}</div></div>`;
  } else if (action === 'esa') {
    body = `<div class="ed-grid"><div class="span3"><label for="p-esa">Link to the copy on the ESA SharePoint</label><input id="p-esa" type="url" value="${esc(v.esa_url ?? '')}"></div>
      <div class="span3"><label for="p-comments">ESA comments / changes required</label><textarea id="p-comments" rows="3">${esc(v.esa_comments ?? '')}</textarea></div></div>`;
  } else {
    body = `<p>${confirmOnly[action]}</p>`;
  }
  const buttons = action === 'esa'
    ? `<button type="button" class="secondary" data-go="edit">Save links and comments</button><button type="button" class="secondary" data-go="esa_changes">Changes required</button><button type="button" data-go="esa_accept">Accepted by ESA</button>`
    : `<button type="button" data-go="${action}">Confirm</button>`;
  p.innerHTML = `<div class="card vpanel"><h3>${esc(name)}</h3>${body}<p class="message" id="vp-msg" role="alert" hidden></p>
    <div class="buttons"><span class="spacer"></span><button type="button" class="secondary" data-cancel>Cancel</button>${buttons}</div></div>`;
  p.querySelector('[data-cancel]').addEventListener('click', () => { p.innerHTML = ''; });
  p.scrollIntoView({ block: 'nearest' });
  p.querySelector('#p-num')?.addEventListener('input', (e) => {
    const n = Number(e.target.value);
    if (Number.isInteger(n) && n >= 0 && n <= 99) p.querySelector('h3').textContent = `${baseName(d)}_${vv(n)}`;
  });
  p.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => doVersionAction(d, v, b.dataset.go)));
  p.querySelector('input, textarea')?.focus();
}

async function doVersionAction(d, v, action) {
  let call;
  if (action === 'new') {
    const args = { p_document_id: d.id, p_file_url: val('p-file') || null, p_change_note: val('p-change') || null };
    if ($('#p-num')) {
      const n = Number(val('p-num'));
      if (!Number.isInteger(n) || n < 0 || n > 99) { showError('The version number shall be between 0 and 99.', '#vp-msg'); return; }
      args.p_version = n;
    }
    call = supabase.rpc('doc_new_version', args);
  } else {
    const f = {};
    if ($('#p-file')) f.file_url = val('p-file');
    if ($('#p-change')) f.change_note = val('p-change');
    if ($('#p-note')) f.review_note = val('p-note');
    if ($('#p-sent')) f.sent_on = val('p-sent');
    if ($('#p-esa')) f.esa_url = val('p-esa');
    if ($('#p-comments')) f.esa_comments = val('p-comments');
    if (action === 'send') f.requirements = [...document.querySelectorAll('input[name="p-req"]:checked')].map((x) => Number(x.value));
    if (action === 'delete' && !confirm('Delete the version? This cannot be undone.')) return;
    call = supabase.rpc('doc_version_action', { p_version_id: v.id, p_action: action, p_fields: f });
  }
  const done = { new: 'Version started.', submit: 'Submitted for review.', approve: 'Version approved.', return: 'Version returned to the responsible.',
    send: 'Version marked as sent to ESA.', esa_accept: 'Marked as accepted by ESA.', esa_changes: 'ESA changes recorded.',
    reset: 'Version back in progress.', delete: 'Version deleted.', withdraw: 'Version withdrawn.', edit: 'Version saved.' };
  const r = await run(call, done[action], '#vp-msg');
  if (r.ok) openDoc(d.id);
}

/* ----- Requirements of a document ----- */
function requirementsHtml(d) {
  const rs = reqsOf(d);
  const items = rs.map((r) => {
    const m = MBYID.get(r.milestone_id);
    const st = reqState(r);
    const v = r.version_id ? VBYID.get(r.version_id) : null;
    const t = r.task_id ? TASKS.get(r.task_id) : null;
    const risk = reqRisk(r);
    return `<li><span>${levelSym(r.level)} <b>${esc(m.code)}</b> ${LEVELS[r.level][1]} · <span class="rq-t rq-${st}">${RSTATE[st]}${v ? ` (${vv(v.version)})` : ''}</span>
        ${dueOf(m) ? ` · due ${formatDate(dueOf(m))}` : ''}
        ${t ? ` · task <a href="gantt.html#task=${t.id}" class="mono">${esc(t.code)}</a>` : ''}${risk ? ` <span class="bad">${esc(risk)}</span>` : ''}
        ${r.waived ? `<span class="req">Waived: ${esc(r.waived_reason)}</span>` : ''}${r.note ? `<span class="req">${esc(r.note)}</span>` : ''}</span>
      ${canEdit(d) ? `<button type="button" class="link" data-req="${r.id}">Edit</button>` : ''}</li>`;
  }).join('');
  return `<h3>Required at milestones</h3>
    ${rs.length ? `<ul class="ed-children">${items}</ul>` : '<p class="hint">Not required at any milestone.</p>'}
    ${canEdit(d) ? `<button type="button" class="secondary act" data-add="${d.id}:">Add milestone</button>` : ''}`;
}

async function loadHistory(d) {
  const ul = $('#e-hist ul');
  const { data, error } = await supabase.from('document_history').select('*')
    .eq('document_id', d.id).order('changed_at', { ascending: false }).limit(200);
  if (error) { ul.innerHTML = `<li>${esc(errorText(error))}</li>`; return; }
  const show = (x) => (x == null ? '—' : typeof x === 'object' ? JSON.stringify(x) : String(x));
  ul.innerHTML = data.length ? data.map((h) => {
    const ch = h.changes && h.action.endsWith('updated')
      ? Object.entries(h.changes).filter(([k]) => k !== 'milestone').map(([k, [a, b]]) => `${esc(k)}: ${esc(show(a))} → ${esc(show(b))}`).join('; ')
      : '';
    const ms = h.changes?.milestone ? ` ${esc(Array.isArray(h.changes.milestone) ? h.changes.milestone[1] : h.changes.milestone)}` : '';
    return `<li><span class="mono">${formatDateTime(h.changed_at)}</span> ${esc(nameOf(h.changed_by) || 'system')}: ${esc(h.action)}${h.version != null ? ` ${vv(h.version)}` : ''}${ms}${ch ? ` – ${ch}` : ''}</li>`;
  }).join('') : '<li>No changes recorded.</li>';
}

/* ----- Requirement editor (responsible and document managers; read-only for the others) ----- */
function openRequirement(id, preset = {}) {
  const r = id ? REQS.find((x) => x.id === id) : { document_id: preset.doc ?? null, milestone_id: preset.ms ?? null, level: 'release', waived: false };
  if (!r) { toast('The requirement no longer exists.'); return; }
  const d = r.document_id ? DOCS.find((x) => x.id === r.document_id) : null;
  const sent = d ? versionsOf(d).filter((v) => SENT.includes(v.status)) : [];
  const tasks = [...TASKS.values()].sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
  const edit = d ? canEdit(d) : MANAGER;
  const dis = edit ? '' : ' disabled';
  const html = `<h2>${id ? 'Requirement' : 'New requirement'}</h2>
    <p class="meta">Document required at a milestone. The task of the Gantt that produces it is optional but shows whether the milestone is covered.</p>
    <div class="ed-grid">
      <div class="span3"><label for="q-doc">Document</label><select id="q-doc"${id ? ' disabled' : dis}>${d ? '' : '<option value="">—</option>'}${DOCS.filter((x) => x.id === r.document_id || canEdit(x)).map((x) =>
        `<option value="${x.id}"${x.id === r.document_id ? ' selected' : ''}>${esc(baseName(x))}</option>`).join('')}</select></div>
      <div><label for="q-ms">Milestone</label><select id="q-ms"${id ? ' disabled' : dis}>${r.milestone_id ? '' : '<option value="">—</option>'}${MILES.map((m) =>
        `<option value="${m.id}"${m.id === r.milestone_id ? ' selected' : ''}>${esc(m.code)}</option>`).join('')}</select></div>
      <div><label for="q-level">Level</label><select id="q-level"${dis}>${Object.entries(LEVELS).map(([k, [s, l]]) =>
        `<option value="${k}"${r.level === k ? ' selected' : ''}>${s} ${l}</option>`).join('')}</select></div>
      <div><label for="q-ver">Fulfilled by</label><select id="q-ver"${id ? dis : ' disabled'}><option value="">— not delivered —</option>${sent.map((v) =>
        `<option value="${v.id}"${v.id === r.version_id ? ' selected' : ''}>${vv(v.version)} (${esc(VSTATUS[v.status])})</option>`).join('')}</select></div>
      <div class="span3"><label for="q-task">Task of the Gantt producing it</label><select id="q-task"${dis}><option value="">— none —</option>${tasks.map((t) =>
        `<option value="${t.id}"${t.id === r.task_id ? ' selected' : ''}>${esc(t.code)} – ${esc(t.name)} (end ${formatDate(t.deadline ?? t.end_date)})</option>`).join('')}</select></div>
      <div class="span3"><label class="pk chk"><input id="q-waived" type="checkbox"${r.waived ? ' checked' : ''}${dis}> Waived (not required any more, or delivered before this tool)</label>
        <input id="q-waived-reason" placeholder="Reason" value="${esc(r.waived_reason ?? '')}"${dis}${r.waived ? '' : ' hidden'}></div>
      <div class="span3"><label for="q-note">Expected content</label><textarea id="q-note" rows="2"${dis}>${esc(r.note ?? '')}</textarea></div>
    </div>
    <p class="message" id="d-msg" role="alert" hidden></p>
    <div class="buttons">${id && edit ? '<button type="button" class="danger" id="q-del">Remove</button>' : ''}
      <span class="spacer"></span>
      ${d ? '<button type="button" class="secondary" id="q-doc-open">Open document</button>' : ''}
      <button type="button" class="secondary" data-close>Close</button>
      ${edit ? '<button type="button" id="q-save">Save</button>' : ''}</div>`;
  showModal(html, false);
  const m = modal();
  m.querySelector('#q-waived').addEventListener('change', (e) => { $('#q-waived-reason').hidden = !e.target.checked; });
  m.querySelector('#q-doc-open')?.addEventListener('click', () => {
    if (m.dirty && !confirm('Discard the unsaved changes?')) return;
    openDoc(d.id);
  });
  m.querySelector('#q-del')?.addEventListener('click', async () => {
    if (!confirm('Remove the document from this milestone?')) return;
    const res = await run(supabase.from('document_requirements').delete().eq('id', id), 'Requirement removed.', '#d-msg');
    if (res.ok) closeModal();
  });
  m.querySelector('#q-save')?.addEventListener('click', async () => {
    const waived = $('#q-waived').checked;
    const row = {
      level: $('#q-level').value,
      task_id: $('#q-task').value ? Number($('#q-task').value) : null,
      waived, waived_reason: waived ? val('q-waived-reason') || null : null,
      note: val('q-note') || null,
    };
    let call;
    if (id) {
      row.version_id = $('#q-ver').value ? Number($('#q-ver').value) : null;
      call = supabase.from('document_requirements').update(row).eq('id', id);
    } else {
      if (!$('#q-doc').value || !$('#q-ms').value) { showError('Select document and milestone.', '#d-msg'); return; }
      call = supabase.from('document_requirements').insert({ ...row, document_id: Number($('#q-doc').value), milestone_id: Number($('#q-ms').value) });
    }
    const res = await run(call, 'Requirement saved.', '#d-msg');
    if (res.ok) closeModal();
  });
}

/* ----- Milestone editor (document managers) ----- */
function openMilestone(id) {
  const m = id ? MBYID.get(id) : { code: '', name: '', sort_order: (MILES.at(-1)?.sort_order ?? 0) + 10 };
  const n = id ? REQS.filter((r) => r.milestone_id === id).length : 0;
  const html = `<h2>${id ? `Milestone ${esc(m.code)}` : 'New milestone'}</h2>
    <p class="meta">Review of the project. The data package is due before the review; the Gantt shows the review date.</p>
    <div class="ed-grid">
      <div><label for="m-code">Code</label><input id="m-code" maxlength="16" value="${esc(m.code)}" placeholder="CDR"></div>
      <div class="span2"><label for="m-name">Name</label><input id="m-name" maxlength="80" value="${esc(m.name)}"></div>
      <div><label for="m-phase">Phase</label><input id="m-phase" maxlength="20" value="${esc(m.phase ?? '')}"></div>
      <div><label for="m-order">Order</label><input id="m-order" type="number" step="1" value="${m.sort_order}"></div>
      <div></div>
      <div><label for="m-due">Data package due</label><input id="m-due" type="date" value="${m.docs_due ?? ''}"></div>
      <div><label for="m-review">Review (planned)</label><input id="m-review" type="date" value="${m.review_date ?? ''}"></div>
      <div><label for="m-held">Held on</label><input id="m-held" type="date" max="${TODAY}" value="${m.held_on ?? ''}"></div>
      <div class="span3"><label for="m-note">Note</label><textarea id="m-note" rows="3">${esc(m.note ?? '')}</textarea></div>
    </div>
    <p class="message" id="d-msg" role="alert" hidden></p>
    <div class="buttons">${id ? `<button type="button" class="danger" id="m-del">Delete</button>` : ''}
      <span class="spacer"></span><button type="button" class="secondary" data-close>Close</button>
      <button type="button" id="m-save">Save</button></div>`;
  showModal(html, false);
  const box = modal();
  box.querySelector('#m-save').addEventListener('click', async () => {
    const row = {
      code: val('m-code').toUpperCase(), name: val('m-name'), phase: val('m-phase') || null,
      sort_order: Number(val('m-order')) || 0, docs_due: val('m-due') || null, review_date: val('m-review') || null,
      held_on: val('m-held') || null, note: val('m-note') || null,
    };
    const call = id ? supabase.from('milestones').update(row).eq('id', id) : supabase.from('milestones').insert(row);
    const res = await run(call, 'Milestone saved.', '#d-msg');
    if (res.ok) closeModal();
  });
  box.querySelector('#m-del')?.addEventListener('click', async () => {
    if (!confirm(`Delete ${m.code}${n ? ` and its ${n} required documents` : ''}? The documents themselves are kept.`)) return;
    const res = await run(supabase.from('milestones').delete().eq('id', id), 'Milestone deleted.', '#d-msg');
    if (res.ok) closeModal();
  });
}

/* ---------- events ---------- */
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-open], [data-req], [data-add], [data-ms], [data-close]');
  if (!t || e.target.closest('a[href]')) return;
  // Moving to another dialog from an open one: confirm first if something was typed
  if (t.dataset.close === undefined && !modal().hidden && modal().dirty && !confirm('Discard the unsaved changes?')) return;
  if (t.dataset.close !== undefined) requestClose();
  else if (t.dataset.req) openRequirement(Number(t.dataset.req));
  else if (t.dataset.add) {
    const [doc, ms] = t.dataset.add.split(':');
    openRequirement(null, { doc: Number(doc) || null, ms: Number(ms) || null });
  } else if (t.dataset.ms) openMilestone(Number(t.dataset.ms));
  else if (t.dataset.open) openDoc(Number(t.dataset.open));
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modal().hidden) requestClose();
  if (e.key === 'Enter' && e.target.matches('[data-open], [data-ms]') && modal().hidden) e.target.click();
});
modal().addEventListener('mousedown', (e) => { if (e.target === modal()) requestClose(); });
// Something typed in a dialog: closing it asks for confirmation
modal().addEventListener('input', () => { modal().dirty = true; });
modal().addEventListener('change', () => { modal().dirty = true; });

// Address: #register, #milestones, #review (view) or #doc=ID (document)
function route() {
  const h = location.hash.slice(1);
  if (VIEWS.some(([k]) => k === h)) {
    if (!modal().hidden) {
      if (modal().dirty && !confirm('Discard the unsaved changes?')) return;
      modal().hidden = true;
      modal().innerHTML = '';
      modal().dirty = false;
    }
    ui.view = h;
    store('docs-view', h);
  }
  render();
  const m = /^doc=(\d+)$/.exec(h);
  if (m) openDoc(Number(m[1]));
}
window.addEventListener('hashchange', route);

/* ---------- start ---------- */
if (profile) {
  try {
    await load();
    route();
  } catch (err) {
    console.error(err);
    $('#view').innerHTML = `<p class="message error">${esc(errorText(err))}</p>`;
  }
}
