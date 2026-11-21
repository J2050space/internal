// Home: what concerns the user (next lab hours, own shift requests, tasks led,
// documents of which the user is responsible, own lab hours) and, for the
// admins, what waits for them. Each card links to the item on its page.
import { supabase } from './config.js';
import { initProtectedPage, friendlyError } from './auth.js';
import { formatDate, formatTime, todayIso } from './format.js';
import { icon } from './icons.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dn = (d) => Math.round(Date.parse(`${d}T00:00:00Z`) / 864e5);
const vv = (n) => `V${String(n).padStart(2, '0')}`;
const h1 = (n) => (Math.round(n * 10) / 10).toFixed(1);
const short = (s, n = 70) => (s.length > n ? `${s.slice(0, n)}…` : s);

const profile = await initProtectedPage('home');
const ME = profile?.id;
const ADMIN = profile?.role === 'admin';
const LEADER_ROLE = profile?.role === 'teamleader' || ADMIN;
const TODAY = todayIso();

// "in 3 d", "today", "2 d late"
function dueText(date) {
  const n = dn(date) - dn(TODAY);
  return n < 0 ? `${-n} d late` : n === 0 ? 'today' : `in ${n} d`;
}

// Kind of card: colour and icon (css/home.css)
const KINDS = { lab: 'calendar', requests: 'send', tasks: 'list-checks', docs: 'file-text', hours: 'clock', admin: 'inbox' };
function card(kind, title, body, { link = null, count = null, alert = false } = {}) {
  return `<section class="card home-card k-${kind}${alert ? ' attn' : ''}">
    <h2><span class="k-icon">${icon(KINDS[kind], 16)}</span><span class="k-title">${title}</span>
      ${count != null ? `<span class="k-count${alert ? ' alert' : ''}">${count}</span>` : ''}
      ${link ? `<a class="more" href="${link[0]}">${link[1]} →</a>` : ''}</h2>${body}</section>`;
}
const list = (items, empty) => (items.length ? `<ul class="home-list">${items.join('')}</ul>` : `<p class="hint">${empty}</p>`);
const check = (...results) => { const e = results.find((r) => r.error); if (e) throw e.error; };

/* ---------- admins: things waiting ---------- */
async function adminCard() {
  const [req, rev, appr, mem] = await Promise.all([
    supabase.from('shift_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('document_versions').select('id', { count: 'exact', head: true }).eq('status', 'in_review'),
    supabase.from('document_versions').select('id', { count: 'exact', head: true }).eq('status', 'approved'),
    supabase.rpc('admin_list_members'),
  ]);
  check(req, rev, appr, mem);
  const waiting = mem.data.filter((m) => m.status === 'pending' && m.email_confirmed).length;
  const tile = (n, text, href) => `<a class="todo-tile${n ? ' on' : ''}" href="${href}"><b>${n}</b><span>${text}</span></a>`;
  const total = waiting + (req.count ?? 0) + (rev.count ?? 0) + (appr.count ?? 0);
  return `<section class="home-admin">
    <h2 class="zone">${icon('inbox', 16)} Waiting for the admins <span class="k-count${total ? ' alert' : ''}">${total}</span></h2>
    <div class="todo-tiles">
      ${tile(waiting, 'accounts awaiting approval', 'members.html')}
      ${tile(req.count ?? 0, 'shift requests to approve or reject', 'shifts.html')}
      ${tile(rev.count ?? 0, 'versions to approve or return', 'documents.html#review')}
      ${tile(appr.count ?? 0, 'approved versions to send to ESA', 'documents.html#review')}
    </div></section>`;
}

/* ---------- next lab hours ---------- */
async function bookingsCard() {
  const res = await supabase.from('assignments')
    .select('shift_id, role, starts_at, ends_at, shifts(location, tasks(code, name))')
    .eq('user_id', ME).gt('ends_at', new Date().toISOString())
    .order('starts_at').limit(8);
  check(res);
  const items = res.data.map((b) => {
    const task = b.shifts?.tasks;
    return `<li><a href="shifts.html#shift=${b.shift_id}"><span class="when">${formatDate(b.starts_at)} ${formatTime(b.starts_at)}–${formatTime(b.ends_at)}</span>
      ${task ? `<span class="code">${esc(task.code)}</span> ${esc(task.name)}` : 'Shift'}</a>
      <span class="hint">${b.role === 'supervisor' ? 'Supervisor' : 'Participant'}${b.shifts?.location ? ` · ${esc(b.shifts.location)}` : ''}</span></li>`;
  });
  return card('lab', 'My next lab hours', list(items, `No booking. ${ADMIN ? 'Join a shift as supervisor' : 'Book a shift, or request one,'} in Lab shifts.`),
    { link: ['shifts.html', 'Lab shifts'], count: res.data.length });
}

/* ---------- own shift requests: pending, and decided in the last 14 days ---------- */
const REQ_STATE = { pending: ['late_start', 'Pending'], approved: ['done', 'Approved'], rejected: ['overdue', 'Rejected'], withdrawn: ['planned', 'Withdrawn'] };
async function requestsCard() {
  const res = await supabase.from('shift_requests')
    .select('id, status, starts_at, ends_at, description, admin_note, decided_at')
    .eq('requested_by', ME).gte('created_at', new Date(Date.now() - 60 * 864e5).toISOString())
    .order('starts_at');
  check(res);
  const recent = Date.now() - 14 * 864e5;
  const rs = res.data.filter((r) => r.status === 'pending' || (r.decided_at && Date.parse(r.decided_at) >= recent));
  if (!rs.length) return '';
  const items = rs.map((r) => {
    const [cls, label] = REQ_STATE[r.status] ?? ['planned', r.status];
    return `<li><a href="shifts.html#request=${r.id}"><span class="when">${formatDate(r.starts_at)} ${formatTime(r.starts_at)}–${formatTime(r.ends_at)}</span>
      ${esc(short(r.description))}</a><span class="st ${cls}">${label}</span>
      ${r.admin_note ? `<span class="hint">Admin: ${esc(r.admin_note)}</span>` : ''}</li>`;
  });
  return card('requests', 'My shift requests', list(items, ''),
    { link: ['shifts.html', 'Lab shifts'], count: rs.length, alert: rs.some((r) => r.status === 'rejected') });
}

/* ---------- tasks led (same status rule as the Gantt) ---------- */
const STATUS = { planned: 'Planned', late_start: 'Not started (late)', progress: 'In progress', overdue: 'Overdue' };
const RANK = { blocked: 0, overdue: 1, late_start: 2, progress: 3, planned: 4 };
async function tasksCard() {
  const [tl, t] = await Promise.all([
    supabase.from('task_leaders').select('task_id').eq('leader_id', ME),
    supabase.from('tasks').select('id, code, name, start_date, end_date, deadline, started_on, completed_on, blocked, blocked_reason'),
  ]);
  check(tl, t);
  const mine = new Set(tl.data.map((x) => x.task_id));
  const open = t.data.filter((x) => mine.has(x.id) && !x.completed_on).map((x) => {
    const status = x.started_on ? (TODAY > x.end_date ? 'overdue' : 'progress') : (TODAY >= x.start_date ? 'late_start' : 'planned');
    return { ...x, status, due: x.deadline ?? x.end_date, rank: x.blocked ? RANK.blocked : RANK[status] };
  }).sort((a, b) => a.rank - b.rank || (a.due < b.due ? -1 : 1));
  if (!open.length && !LEADER_ROLE) return '';
  const items = open.slice(0, 8).map((x) => `<li><a href="gantt.html#task=${x.id}"><span class="code">${esc(x.code)}</span> ${esc(x.name)}</a>
      ${x.blocked ? '<span class="st blocked">Blocked</span>' : ''}<span class="st ${x.status}">${STATUS[x.status]}</span>
      <span class="hint">${x.deadline ? 'Deadline' : 'Planned end'} ${formatDate(x.due)} · <span class="${x.due < TODAY ? 'bad' : ''}">${dueText(x.due)}</span>${x.blocked ? ` · ${esc(x.blocked_reason)}` : ''}</span></li>`);
  const more = open.length > 8 ? `<p class="hint foot">${open.length - 8} more: <a href="gantt.html#table" data-my-tasks>all my tasks</a>.</p>` : '';
  return card('tasks', 'My tasks', list(items, 'No open task of which you are the leader.') + more +
    (open.length ? '<p class="hint foot">Open a task to update its progress.</p>' : ''),
    { link: ['gantt.html#table', 'Project plan'], count: open.length, alert: open.some((x) => x.rank <= RANK.late_start) });
}

/* ---------- documents of which the user is responsible ---------- */
const VSTATUS = { none: 'Not started', in_progress: 'In progress', in_review: 'In review', approved: 'Approved, to send to ESA',
  sent: 'Sent to ESA', esa_accepted: 'Accepted by ESA', esa_changes: 'ESA changes required' };
async function documentsCard() {
  const [d, v, r, m] = await Promise.all([
    supabase.from('documents').select('id, subteam, doc_type, title, name, on_hold').eq('responsible_id', ME),
    supabase.from('document_versions').select('document_id, version, status, review_note'),
    supabase.from('document_requirements').select('document_id, milestone_id, level, version_id, waived'),
    supabase.from('milestones').select('id, code, docs_due, review_date'),
  ]);
  check(d, v, r, m);
  if (!d.data.length && !LEADER_ROLE) return '';
  const ms = new Map(m.data.map((x) => [x.id, x]));
  const docs = d.data.map((doc) => {
    const last = v.data.filter((x) => x.document_id === doc.id).sort((a, b) => b.version - a.version)[0] ?? null;
    const next = r.data
      .filter((x) => x.document_id === doc.id && !x.waived && !x.version_id && x.level !== 'ad_hoc')
      .map((x) => ({ code: ms.get(x.milestone_id)?.code ?? '?', due: ms.get(x.milestone_id)?.docs_due ?? ms.get(x.milestone_id)?.review_date ?? null }))
      .filter((x) => x.due).sort((a, b) => (a.due < b.due ? -1 : 1))[0] ?? null;
    return { ...doc, last, next };
  }).sort((a, b) => (a.next?.due ?? '9999') < (b.next?.due ?? '9999') ? -1 : 1);
  const items = docs.slice(0, 8).map((doc) => {
    const status = doc.last?.status ?? 'none';
    const returned = status === 'in_progress' && doc.last.review_note;
    return `<li><a href="documents.html#doc=${doc.id}"><span class="mono">${esc(`${doc.subteam}_${doc.doc_type}_${doc.title}`)}</span></a>
      <span class="st ds-${status}">${doc.last ? `${vv(doc.last.version)} ` : ''}${VSTATUS[status]}</span>
      <span class="hint">${returned ? `<span class="bad">Returned: ${esc(doc.last.review_note)}</span> · ` : ''}${doc.on_hold ? 'On hold · ' : ''}${doc.next
        ? `Next delivery ${esc(doc.next.code)} ${formatDate(doc.next.due)} · <span class="${doc.next.due < TODAY ? 'bad' : ''}">${dueText(doc.next.due)}</span>`
        : 'No delivery due'}</span></li>`;
  });
  const more = docs.length > 8 ? `<p class="hint foot">${docs.length - 8} more in Documents (tick <i>My documents</i>).</p>` : '';
  const late = docs.some((doc) => (doc.next && doc.next.due < TODAY) || (doc.last?.status === 'in_progress' && doc.last.review_note));
  return card('docs', 'My documents', list(items, 'You are not responsible of any document.') + more,
    { link: ['documents.html#register', 'Documents'], count: docs.length, alert: late });
}

/* ---------- own lab hours ---------- */
async function hoursCard() {
  const from30 = new Date(Date.parse(`${TODAY}T00:00:00Z`) - 29 * 864e5).toISOString().slice(0, 10);
  const [a, b] = await Promise.all([
    supabase.rpc('lab_hours', { p_from: from30, p_to: TODAY }),
    supabase.rpc('lab_hours', { p_from: '2020-01-01', p_to: TODAY }),
  ]);
  check(a, b);
  const own = (rows) => rows.filter((x) => x.user_id === ME).reduce((s, x) => s + Number(x.hours), 0);
  return card('hours', 'My lab hours', `<ul class="home-kpi"><li>Last 30 days<b>${h1(own(a.data))} h</b></li><li>Total<b>${h1(own(b.data))} h</b></li></ul>
    <p class="hint foot">Hours of the shifts already ended, as booked.</p>`, { link: ['stats.html', 'Stats'] });
}

/* ---------- start ---------- */
// A card that cannot be read shows its error, the others are shown anyway
const safe = (kind, title, fn) => fn().catch((err) => card(kind, title, `<p class="message error">${esc(friendlyError(err))}</p>`));

if (profile) {
  document.getElementById('h-title').textContent = `Hello, ${profile.first_name}`;
  document.getElementById('h-sub').textContent = `${formatDate(TODAY)} – things going on today`;
  const [admin, ...cards] = await Promise.all([
    ADMIN ? safe('admin', 'Waiting for the admins', adminCard) : '',
    safe('tasks', 'My tasks', tasksCard),
    safe('docs', 'My documents', documentsCard),
    safe('lab', 'My next lab hours', bookingsCard),
    safe('requests', 'My shift requests', requestsCard),
    safe('hours', 'My lab hours', hoursCard),
  ]);
  document.getElementById('h-admin').innerHTML = admin;
  document.getElementById('h-zone').hidden = !ADMIN;
  document.getElementById('h-grid').innerHTML = cards.join('');
}

// "All my tasks": open the project plan with "My tasks" ticked
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-my-tasks]')) return;
  try { localStorage.setItem('gantt-mine', 'true'); } catch { /* storage unavailable */ }
});
