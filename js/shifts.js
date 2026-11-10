// Lab shifts: two weekly grids (Mon-Fri, 08:00-18:00), booking, admin management, shift requests.
import { supabase } from './config.js';
import { initProtectedPage, friendlyError } from './auth.js';
import { formatDate, formatTime, formatDateTime, zonedParts, zonedToIso, todayIso } from './format.js';

/* ---------- constants ---------- */
const DAY_START = 8 * 60;      // 08:00
const DAY_END = 18 * 60;       // 18:00
const SLOT = 30;               // minutes per grid row
const SLOT_PX = 24;            // must match --slot in shifts.css
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const MAX_CAPACITY = 50;
const HISTORY_DAYS = 30;

/* ---------- utilities ---------- */
const dn = (i) => { const p = i.split('-').map(Number); return Math.round(Date.UTC(p[0], p[1] - 1, p[2]) / 864e5); };
const iso = (n) => new Date(n * 864e5).toISOString().slice(0, 10);
const weekday = (isoDate) => (new Date(dn(isoDate) * 864e5).getUTCDay() + 6) % 7; // 0 = Monday
const mondayOf = (isoDate) => iso(dn(isoDate) - weekday(isoDate));
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const personName = (p) => p?.full_name ?? p?.email ?? 'Unknown';

function toast(message) {
  const t = document.getElementById('toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toast.h);
  toast.h = setTimeout(() => { t.hidden = true; }, 5000);
}

const ERRORS = {
  'Shift full': 'The shift is full.',
  'Already booked': 'You are already booked on this shift.',
  'Overlapping shift': 'You (or the requester) already have a shift overlapping this one.',
  'Shift already started': 'The shift has already started.',
  'Shift not found': 'The shift no longer exists.',
  'Capacity lower than current bookings': 'The capacity cannot be lower than the number of people booked.',
  'Task required': 'Select a task.',
  'Request not found': 'The request no longer exists.',
  'Request not pending': 'The request has already been handled.',
  'Request not found or not pending': 'The request has already been handled.',
  'Requester account not active': 'The requester account is not active.',
};
function errorText(error) {
  const m = error?.message ?? String(error);
  if (/row-level security/.test(m) && /shift_requests/.test(m)) return 'The requested start is in the past.';
  if (/shifts_check|shift_requests_check/.test(m)) return 'The end time shall be after the start time.';
  if (/capacity_check/.test(m)) return 'The capacity shall be at least 1.';
  return ERRORS[m] ?? friendlyError(error);
}

/* ---------- state ---------- */
const profile = await initProtectedPage('shifts');
const ADMIN = profile?.role === 'admin';
const ME = profile?.id;
const TODAY = todayIso();
let SHIFTS = [];
let REQUESTS = [];
let TASKS = [];
const ui = { week: 0, onlyFree: false, onlyMine: false };

const firstMonday = () => iso(dn(mondayOf(TODAY)) + ui.week * 7);

/* ---------- data ---------- */
async function load() {
  const from = firstMonday();
  const to = iso(dn(from) + 14);
  const since = new Date(Date.now() - 2 * HISTORY_DAYS * 864e5).toISOString();
  const [s, r, t] = await Promise.all([
    supabase.from('shifts')
      .select('*, tasks(code, name), assignments(user_id, created_at, profiles(full_name, email))')
      .gte('starts_at', zonedToIso(from, '00:00'))
      .lt('starts_at', zonedToIso(to, '00:00'))
      .order('starts_at'),
    supabase.from('shift_requests')
      .select('*, requester:profiles!shift_requests_requested_by_fkey(full_name, email), tasks(code, name)')
      .gte('created_at', since)
      .order('starts_at'),
    supabase.from('tasks').select('id, code, name, status, parent_id'),
  ]);
  const error = s.error || r.error || t.error;
  if (error) throw error;

  const now = new Date();
  SHIFTS = s.data.map((x) => {
    const start = zonedParts(x.starts_at);
    const end = zonedParts(x.ends_at);
    const people = x.assignments
      .slice().sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
      .map((a) => ({ id: a.user_id, name: personName(a.profiles) }));
    return {
      ...x,
      date: start.date,
      startMin: start.minutes,
      endMin: end.date === start.date ? end.minutes : DAY_END + 1,
      people,
      booked: people.length,
      mine: people.some((p) => p.id === ME),
      started: new Date(x.starts_at) <= now,
      full: people.length >= x.capacity,
    };
  });
  REQUESTS = r.data;
  TASKS = t.data.sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
}

async function reload(message) {
  try { await load(); } catch (err) { toast(errorText(err)); return; }
  render();
  if (message) toast(message);
}

/* ---------- toolbar ---------- */
function renderTools() {
  const from = firstMonday();
  const to = iso(dn(from) + 11); // Friday of the second week
  document.getElementById('s-tools').innerHTML = `
    <button type="button" class="secondary" data-act="prev" aria-label="Previous week">◀</button>
    <button type="button" class="secondary" data-act="now"${ui.week === 0 ? ' disabled' : ''}>This week</button>
    <button type="button" class="secondary" data-act="next" aria-label="Next week">▶</button>
    <span class="range">${formatDate(from)} – ${formatDate(to)}</span>
    <label class="chk"><input type="checkbox" id="f-free"${ui.onlyFree ? ' checked' : ''}> Free seats only</label>
    <label class="chk"><input type="checkbox" id="f-mine"${ui.onlyMine ? ' checked' : ''}> My shifts only</label>
    <button type="button" class="secondary" data-act="reload">Reload</button>`;
  document.getElementById('s-actions').innerHTML = ADMIN
    ? '<button type="button" data-act="new-shift">New shift</button>'
    : '<button type="button" data-act="new-request">Request a shift</button>';
}

/* ---------- grid ---------- */
function visible(s) {
  if (ui.onlyFree && (s.full || s.started)) return false;
  if (ui.onlyMine && !s.mine) return false;
  return true;
}

function blockClass(s) {
  return `${s.mine ? 'mine' : s.full ? 'full' : 'free'}${s.started ? ' past' : ''}`;
}

function blockText(s) {
  const task = s.tasks ? `<span class="c">${esc(s.tasks.code)}</span> ${esc(s.tasks.name)}` : '';
  return `<span class="seats">${s.booked}/${s.capacity}</span>
    <span class="t">${formatTime(s.starts_at)}–${formatTime(s.ends_at)}</span><br>${task}
    ${s.location ? `<br><span class="n">${esc(s.location)}</span>` : ''}
    ${s.people.length ? `<br><span class="n">${esc(s.people.map((p) => p.name).join(', '))}</span>` : ''}`;
}

// Assigns side-by-side lanes to overlapping shifts of the same day.
function lanes(dayShifts) {
  const sorted = dayShifts.slice().sort((a, b) => a.startMin - b.startMin);
  const laneEnds = [];
  sorted.forEach((s) => {
    let lane = laneEnds.findIndex((end) => end <= s.startMin);
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(0); }
    laneEnds[lane] = s.endMin;
    s.lane = lane;
  });
  sorted.forEach((s) => { s.lanes = Math.max(laneEnds.length, 1); });
  return sorted;
}

function weekHtml(monday) {
  const days = DAYS.map((label, i) => ({ label, date: iso(dn(monday) + i) }));
  const height = ((DAY_END - DAY_START) / SLOT) * SLOT_PX;
  const outside = [];

  let times = '';
  for (let m = DAY_START; m <= DAY_END; m += 60) {
    times += `<span style="top:${((m - DAY_START) / SLOT) * SLOT_PX}px">${hhmm(m)}</span>`;
  }

  let heads = '<div class="corner"></div>';
  let bodies = `<div class="times" style="height:${height}px">${times}</div>`;
  let list = '';

  days.forEach((d) => {
    const isToday = d.date === TODAY;
    const isPast = d.date < TODAY;
    heads += `<div class="dhead${isToday ? ' today' : ''}">${d.label} ${formatDate(d.date).slice(0, 5)}</div>`;

    const dayShifts = SHIFTS.filter((s) => s.date === d.date && visible(s));
    const inGrid = dayShifts.filter((s) => s.endMin > DAY_START && s.startMin < DAY_END);
    dayShifts.filter((s) => !inGrid.includes(s)).forEach((s) => outside.push(s));

    const blocks = lanes(inGrid).map((s) => {
      const top = ((Math.max(s.startMin, DAY_START) - DAY_START) / SLOT) * SLOT_PX;
      const bottom = ((Math.min(s.endMin, DAY_END) - DAY_START) / SLOT) * SLOT_PX;
      const w = 100 / s.lanes;
      return `<button type="button" class="sblock ${blockClass(s)}" data-shift="${s.id}"
        style="top:${top + 1}px;height:${Math.max(bottom - top - 2, 18)}px;left:calc(${s.lane * w}% + 2px);width:calc(${w}% - 4px)"
        title="${esc(`${formatTime(s.starts_at)}–${formatTime(s.ends_at)} ${s.tasks?.code ?? ''} ${s.booked}/${s.capacity}`)}">${blockText(s)}</button>`;
    }).join('');
    bodies += `<div class="dbody${isToday ? ' today' : ''}${isPast ? ' past' : ''}" data-date="${d.date}" style="height:${height}px">${blocks}</div>`;

    list += `<div class="lday${isToday ? ' today' : ''}">${d.label} ${formatDate(d.date)}</div>` +
      (dayShifts.length
        ? dayShifts.map((s) => `<button type="button" class="sblock ${blockClass(s)}" data-shift="${s.id}">${blockText(s)}</button>`).join('')
        : '<p class="none">No shift.</p>');
  });

  const out = outside.length
    ? `<p class="outside">Outside the 08:00–18:00 grid: ${outside.map((s) =>
      `<a href="#" data-shift="${s.id}">${formatDateTime(s.starts_at)} ${esc(s.tasks?.code ?? '')}</a>`).join(', ')}</p>`
    : '';

  return `<section class="week"><h2>Week ${formatDate(monday)} – ${formatDate(iso(dn(monday) + 4))}</h2>
    <div class="wscroll"><div class="wgrid">${heads}${bodies}</div></div>
    <div class="wlist">${list}</div>${out}</section>`;
}

/* ---------- requests ---------- */
function requestsHtml() {
  const pending = REQUESTS.filter((r) => r.status === 'pending');
  const sinceHist = new Date(Date.now() - HISTORY_DAYS * 864e5).toISOString();
  const history = REQUESTS.filter((r) => r.status !== 'pending' && (r.decided_at ?? r.created_at) >= sinceHist)
    .sort((a, b) => ((a.decided_at ?? '') < (b.decided_at ?? '') ? 1 : -1));

  const when = (r) => `${formatDate(r.starts_at)}<br><span class="hint">${formatTime(r.starts_at)}–${formatTime(r.ends_at)}</span>`;
  const task = (r) => (r.tasks ? `${esc(r.tasks.code)} ${esc(r.tasks.name)}` : '<span class="hint">—</span>');

  const pendingRows = pending.map((r) => {
    const own = r.requested_by === ME;
    const acts = [
      ADMIN ? `<button type="button" data-act="approve" data-req="${r.id}">Approve</button>` : '',
      ADMIN ? `<button type="button" class="danger" data-act="reject" data-req="${r.id}">Reject</button>` : '',
      own ? `<button type="button" class="secondary" data-act="withdraw" data-req="${r.id}">Withdraw</button>` : '',
    ].join('');
    return `<tr><td>${esc(personName(r.requester))}</td><td>${when(r)}</td><td>${task(r)}</td>
      <td>${esc(r.description)}</td><td>${esc(r.location ?? '')}</td><td>${formatDate(r.created_at)}</td>
      <td class="actions">${acts}</td></tr>`;
  }).join('');

  const histRows = history.map((r) => `<tr><td><span class="st ${r.status}">${r.status}</span></td>
    <td>${esc(personName(r.requester))}</td><td>${when(r)}</td><td>${task(r)}</td><td>${esc(r.description)}</td>
    <td>${esc(r.admin_note ?? '')}</td><td>${r.decided_at ? formatDate(r.decided_at) : ''}</td></tr>`).join('');

  return `<h2>Shift requests (${pending.length} pending)</h2>
    <p class="hint">Members request a shift when none is available; an administrator approves it (the shift is created and the requester booked) or rejects it.</p>
    ${pending.length ? `<div class="table-scroll"><table><thead><tr><th>Requested by</th><th>When</th><th>Task</th><th>Work to do</th><th>Location</th><th>Requested on</th><th></th></tr></thead>
      <tbody>${pendingRows}</tbody></table></div>` : '<p class="hint">No pending request.</p>'}
    <details class="hist"><summary>Handled in the last ${HISTORY_DAYS} days (${history.length})</summary>
      ${history.length ? `<div class="table-scroll"><table><thead><tr><th>Outcome</th><th>Requested by</th><th>When</th><th>Task</th><th>Work to do</th><th>Admin note</th><th>Decided on</th></tr></thead>
        <tbody>${histRows}</tbody></table></div>` : '<p class="hint">None.</p>'}
    </details>`;
}

/* ---------- render ---------- */
function render() {
  renderTools();
  const monday = firstMonday();
  document.getElementById('weeks').innerHTML = weekHtml(monday) + weekHtml(iso(dn(monday) + 7));
  document.getElementById('requests').innerHTML = requestsHtml();
}

/* ---------- modal ---------- */
const modal = document.getElementById('modal');
function openModal(html) {
  modal.innerHTML = `<div class="mbox" role="dialog" aria-modal="true">${html}</div>`;
  modal.hidden = false;
  return modal.querySelector('.mbox');
}
function closeModal() { modal.hidden = true; modal.innerHTML = ''; }
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });

function modalError(box, text) {
  const p = box.querySelector('.message');
  p.textContent = text;
  p.className = 'message error';
  p.hidden = !text;
}

/* ---------- shift details ---------- */
function openShift(id) {
  const s = SHIFTS.find((x) => x.id === id);
  if (!s) return;
  const canBook = !s.started && !s.mine && !s.full;
  const canCancel = !s.started && s.mine;
  const people = s.people.length
    ? `<ul class="people">${s.people.map((p) => `<li><span>${esc(p.name)}${p.id === ME ? ' (you)' : ''}</span>
        ${ADMIN ? `<button type="button" class="danger" data-act="remove-person" data-user="${p.id}">Remove</button>` : ''}</li>`).join('')}</ul>`
    : '<p class="hint">Nobody booked yet.</p>';
  const box = openModal(`
    <h2>${s.tasks ? `${esc(s.tasks.code)} – ${esc(s.tasks.name)}` : 'Shift'}</h2>
    <p class="meta">${DAYS[weekday(s.date)] ?? ''} ${formatDate(s.starts_at)}, ${formatTime(s.starts_at)}–${formatTime(s.ends_at)}
      · ${s.booked}/${s.capacity} booked${s.started ? ' · started or past' : ''}</p>
    <dl>
      ${s.location ? `<dt>Location</dt><dd>${esc(s.location)}</dd>` : ''}
      ${s.description ? `<dt>Work to do</dt><dd>${esc(s.description)}</dd>` : ''}
      ${s.notes ? `<dt>Notes</dt><dd>${esc(s.notes)}</dd>` : ''}
    </dl>
    <h2 style="font-size:.95rem">People</h2>${people}
    <p class="message" role="alert" hidden></p>
    <div class="buttons">
      ${ADMIN ? '<button type="button" class="danger" data-act="delete-shift">Delete shift</button>' : ''}
      ${ADMIN ? '<button type="button" class="secondary" data-act="edit-shift">Edit</button>' : ''}
      ${canCancel ? '<button type="button" class="danger" data-act="cancel-booking">Cancel my booking</button>' : ''}
      ${canBook ? '<button type="button" data-act="book">Book</button>' : ''}
      <button type="button" class="secondary" data-act="close">Close</button>
    </div>`);

  box.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'close') { closeModal(); return; }
    if (act === 'edit-shift') { openShiftForm(s); return; }
    b.disabled = true;
    let error = null;
    let message = '';
    if (act === 'book') {
      ({ error } = await supabase.rpc('book_shift', { p_shift_id: s.id }));
      message = 'Booked.';
    } else if (act === 'cancel-booking') {
      const res = await supabase.from('assignments').delete().eq('shift_id', s.id).eq('user_id', ME).select();
      error = res.error;
      if (!error && !res.data.length) error = { message: 'Shift already started' };
      message = 'Booking cancelled.';
    } else if (act === 'remove-person') {
      const name = s.people.find((p) => p.id === b.dataset.user)?.name ?? '';
      if (!window.confirm(`Remove ${name} from this shift?`)) { b.disabled = false; return; }
      ({ error } = await supabase.from('assignments').delete().eq('shift_id', s.id).eq('user_id', b.dataset.user));
      message = 'Person removed.';
    } else if (act === 'delete-shift') {
      const warn = s.booked ? `\n\n${s.booked} booking(s) will be deleted.` : '';
      if (!window.confirm(`Delete this shift?${warn}`)) { b.disabled = false; return; }
      ({ error } = await supabase.from('shifts').delete().eq('id', s.id));
      message = 'Shift deleted.';
    }
    if (error) { b.disabled = false; modalError(box, errorText(error)); return; }
    closeModal();
    await reload(message);
  });
}

/* ---------- forms ---------- */
function taskOptions(selected, optional) {
  return (optional ? '<option value="">— none —</option>' : '<option value="">— select —</option>') +
    TASKS.map((t) => `<option value="${t.id}"${t.id === selected ? ' selected' : ''}>${esc(t.code)} – ${esc(t.name.slice(0, 70))}${t.status === 'done' ? ' (done)' : ''}</option>`).join('');
}

function slotFields(v) {
  return `<div class="row">
      <div><label for="f-date">Date</label><input id="f-date" type="date" value="${esc(v.date ?? '')}" required></div>
      <div><label for="f-start">Start</label><input id="f-start" type="time" step="1800" min="08:00" max="18:00" value="${esc(v.start ?? '')}" required></div>
      <div><label for="f-end">End</label><input id="f-end" type="time" step="1800" min="08:00" max="18:00" value="${esc(v.end ?? '')}" required></div>
    </div>`;
}

// Returns an error text, or null if the slot is valid.
function checkSlot(date, start, end) {
  if (!date || !start || !end) return 'Date, start and end are required.';
  if (weekday(date) > 4) return 'Shifts are possible from Monday to Friday only.';
  if (toMin(start) < DAY_START || toMin(end) > DAY_END) return 'Shifts are possible between 08:00 and 18:00 only.';
  if (toMin(end) <= toMin(start)) return 'The end time shall be after the start time.';
  if (zonedToIso(date, start) <= new Date().toISOString()) return 'The start shall be in the future.';
  return null;
}

const val = (box, id) => box.querySelector(`#${id}`).value.trim();

// New shift (s undefined, prefill optional) or edit of an existing shift (admin)
function openShiftForm(s, prefill = {}) {
  const v = s
    ? { date: s.date, start: formatTime(s.starts_at), end: formatTime(s.ends_at), task: s.task_id, capacity: s.capacity,
      location: s.location, description: s.description, notes: s.notes }
    : { capacity: 1, ...prefill };
  const box = openModal(`
    <h2>${s ? 'Edit shift' : 'New shift'}</h2>
    <form novalidate>
      ${slotFields(v)}
      <label for="f-task">Task</label><select id="f-task" required>${taskOptions(v.task, false)}</select>
      <label for="f-cap">Capacity (people)</label><input id="f-cap" type="number" min="1" max="${MAX_CAPACITY}" value="${esc(v.capacity)}" required>
      <div class="removal" id="f-removal" hidden></div>
      <label for="f-loc">Location</label><input id="f-loc" type="text" maxlength="80" value="${esc(v.location ?? '')}">
      <label for="f-desc">Work to do</label><textarea id="f-desc" maxlength="1000">${esc(v.description ?? '')}</textarea>
      <label for="f-notes">Notes</label><input id="f-notes" type="text" maxlength="300" value="${esc(v.notes ?? '')}">
      <p class="message" role="alert" hidden></p>
      <div class="buttons"><button type="button" class="secondary" data-act="close">Cancel</button><button type="submit">Save</button></div>
    </form>`);

  const capInput = box.querySelector('#f-cap');
  const removal = box.querySelector('#f-removal');
  const updateRemoval = () => {
    const cap = Number(capInput.value);
    const excess = s ? s.booked - cap : 0;
    if (!s || !(cap >= 1) || excess <= 0) { removal.hidden = true; removal.innerHTML = ''; return; }
    const checked = new Set([...removal.querySelectorAll('input:checked')].map((i) => i.value));
    removal.hidden = false;
    removal.innerHTML = `<p style="margin:0 0 4px">Select the <strong>${excess}</strong> person(s) to remove:</p>` +
      s.people.map((p) => `<label><input type="checkbox" value="${p.id}"${checked.has(p.id) ? ' checked' : ''}> ${esc(p.name)}</label>`).join('');
  };
  capInput.addEventListener('input', updateRemoval);
  box.querySelector('[data-act="close"]').addEventListener('click', closeModal);

  box.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const date = val(box, 'f-date'), start = val(box, 'f-start'), end = val(box, 'f-end');
    const taskId = Number(val(box, 'f-task'));
    const capacity = Math.round(Number(val(box, 'f-cap')));
    const slotChanged = !s || date !== v.date || start !== v.start || end !== v.end;
    const slotError = slotChanged ? checkSlot(date, start, end) : null;
    if (slotError) { modalError(box, slotError); return; }
    if (!taskId) { modalError(box, 'Select a task.'); return; }
    if (!(capacity >= 1 && capacity <= MAX_CAPACITY)) { modalError(box, `The capacity shall be between 1 and ${MAX_CAPACITY}.`); return; }

    const fields = {
      task_id: taskId,
      starts_at: zonedToIso(date, start),
      ends_at: zonedToIso(date, end),
      location: val(box, 'f-loc') || null,
      description: val(box, 'f-desc') || null,
      notes: val(box, 'f-notes') || null,
    };
    const submit = box.querySelector('button[type="submit"]');
    submit.disabled = true;
    let error;
    if (!s) {
      ({ error } = await supabase.from('shifts').insert({ ...fields, capacity }));
    } else {
      const remove = [...removal.querySelectorAll('input:checked')].map((i) => i.value);
      const excess = s.booked - capacity;
      if (excess > 0 && remove.length !== excess) {
        submit.disabled = false;
        modalError(box, `Select exactly ${excess} person(s) to remove.`);
        return;
      }
      ({ error } = await supabase.from('shifts').update(fields).eq('id', s.id));
      if (!error && capacity !== s.capacity) {
        ({ error } = await supabase.rpc('admin_set_capacity', {
          p_shift_id: s.id, p_capacity: capacity, p_remove_user_ids: remove,
        }));
      }
    }
    if (error) { submit.disabled = false; modalError(box, errorText(error)); return; }
    closeModal();
    await reload(s ? 'Shift updated.' : 'Shift created.');
  });
}

// Shift request (members)
function openRequestForm(prefill = {}) {
  const box = openModal(`
    <h2>Request a shift</h2>
    <p class="meta">Describe the work to do. An administrator will open the shift and you will be booked on it.</p>
    <form novalidate>
      ${slotFields(prefill)}
      <label for="f-task">Task of the Gantt (optional)</label><select id="f-task">${taskOptions(null, true)}</select>
      <label for="f-desc">Work to do (required)</label><textarea id="f-desc" maxlength="1000" required></textarea>
      <label for="f-loc">Location</label><input id="f-loc" type="text" maxlength="80">
      <p class="message" role="alert" hidden></p>
      <div class="buttons"><button type="button" class="secondary" data-act="close">Cancel</button><button type="submit">Send request</button></div>
    </form>`);
  box.querySelector('[data-act="close"]').addEventListener('click', closeModal);
  box.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const date = val(box, 'f-date'), start = val(box, 'f-start'), end = val(box, 'f-end');
    const slotError = checkSlot(date, start, end);
    if (slotError) { modalError(box, slotError); return; }
    const description = val(box, 'f-desc');
    if (!description) { modalError(box, 'Describe the work to do.'); return; }
    const taskId = Number(val(box, 'f-task')) || null;
    const submit = box.querySelector('button[type="submit"]');
    submit.disabled = true;
    const { error } = await supabase.from('shift_requests').insert({
      starts_at: zonedToIso(date, start), ends_at: zonedToIso(date, end),
      task_id: taskId, description, location: val(box, 'f-loc') || null,
    });
    if (error) { submit.disabled = false; modalError(box, errorText(error)); return; }
    closeModal();
    await reload('Request sent.');
  });
}

// Approval of a request (admin): creates the shift and books the requester
function openApproveForm(r) {
  const v = {
    date: zonedParts(r.starts_at).date, start: formatTime(r.starts_at), end: formatTime(r.ends_at),
  };
  const box = openModal(`
    <h2>Approve request</h2>
    <p class="meta">Requested by ${esc(personName(r.requester))} on ${formatDate(r.created_at)}. The shift is created and the requester is booked on it.</p>
    <form novalidate>
      ${slotFields(v)}
      <label for="f-task">Task</label><select id="f-task" required>${taskOptions(r.task_id, false)}</select>
      <label for="f-cap">Capacity (1 = requester only)</label><input id="f-cap" type="number" min="1" max="${MAX_CAPACITY}" value="1">
      <label for="f-loc">Location</label><input id="f-loc" type="text" maxlength="80" value="${esc(r.location ?? '')}">
      <label for="f-desc">Work to do</label><textarea id="f-desc" maxlength="1000">${esc(r.description)}</textarea>
      <label for="f-note">Note to the requester</label><input id="f-note" type="text" maxlength="300">
      <p class="message" role="alert" hidden></p>
      <div class="buttons"><button type="button" class="secondary" data-act="close">Cancel</button><button type="submit">Approve and create shift</button></div>
    </form>`);
  box.querySelector('[data-act="close"]').addEventListener('click', closeModal);
  box.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const date = val(box, 'f-date'), start = val(box, 'f-start'), end = val(box, 'f-end');
    const slotError = checkSlot(date, start, end);
    if (slotError) { modalError(box, slotError); return; }
    const taskId = Number(val(box, 'f-task'));
    if (!taskId) { modalError(box, 'Select a task.'); return; }
    const capacity = Math.round(Number(val(box, 'f-cap')));
    if (!(capacity >= 1 && capacity <= MAX_CAPACITY)) { modalError(box, `The capacity shall be between 1 and ${MAX_CAPACITY}.`); return; }
    const submit = box.querySelector('button[type="submit"]');
    submit.disabled = true;
    const { error } = await supabase.rpc('approve_request', {
      p_request_id: r.id,
      p_task_id: taskId,
      p_starts_at: zonedToIso(date, start),
      p_ends_at: zonedToIso(date, end),
      p_capacity: capacity,
      p_location: val(box, 'f-loc') || null,
      p_description: val(box, 'f-desc') || null,
      p_note: val(box, 'f-note') || null,
    });
    if (error) { submit.disabled = false; modalError(box, errorText(error)); return; }
    closeModal();
    await reload('Request approved: shift created.');
  });
}

function openRejectForm(r) {
  const box = openModal(`
    <h2>Reject request</h2>
    <p class="meta">${esc(personName(r.requester))} · ${formatDate(r.starts_at)} ${formatTime(r.starts_at)}–${formatTime(r.ends_at)}</p>
    <form novalidate>
      <label for="f-note">Reason (shown to the team)</label><input id="f-note" type="text" maxlength="300">
      <p class="message" role="alert" hidden></p>
      <div class="buttons"><button type="button" class="secondary" data-act="close">Cancel</button><button type="submit" class="danger">Reject</button></div>
    </form>`);
  box.querySelector('[data-act="close"]').addEventListener('click', closeModal);
  box.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const { error } = await supabase.rpc('reject_request', { p_request_id: r.id, p_note: val(box, 'f-note') || null });
    if (error) { modalError(box, errorText(error)); return; }
    closeModal();
    await reload('Request rejected.');
  });
}

/* ---------- events ---------- */
document.addEventListener('change', (e) => {
  if (e.target.id === 'f-free') { ui.onlyFree = e.target.checked; render(); }
  if (e.target.id === 'f-mine') { ui.onlyMine = e.target.checked; render(); }
});

document.getElementById('app-main').addEventListener('click', async (e) => {
  const shiftEl = e.target.closest('[data-shift]');
  if (shiftEl) { e.preventDefault(); openShift(Number(shiftEl.dataset.shift)); return; }

  const b = e.target.closest('[data-act]');
  if (b) {
    const act = b.dataset.act;
    const req = REQUESTS.find((r) => r.id === Number(b.dataset.req));
    if (act === 'prev') { ui.week -= 1; await reload(); }
    else if (act === 'next') { ui.week += 1; await reload(); }
    else if (act === 'now') { ui.week = 0; await reload(); }
    else if (act === 'reload') await reload('Data reloaded.');
    else if (act === 'new-shift') openShiftForm();
    else if (act === 'new-request') openRequestForm();
    else if (act === 'approve' && req) openApproveForm(req);
    else if (act === 'reject' && req) openRejectForm(req);
    else if (act === 'withdraw' && req) {
      if (!window.confirm('Withdraw this request?')) return;
      const { error } = await supabase.rpc('withdraw_request', { p_request_id: req.id });
      if (error) toast(errorText(error)); else await reload('Request withdrawn.');
    }
    return;
  }

  // Click on an empty slot of a future day: prefilled new shift (admin) or request (members)
  const body = e.target.closest('.dbody');
  if (body && e.target === body && body.dataset.date >= TODAY) {
    const y = e.clientY - body.getBoundingClientRect().top;
    const startMin = Math.min(DAY_START + Math.floor(y / SLOT_PX) * SLOT, DAY_END - SLOT);
    const prefill = { date: body.dataset.date, start: hhmm(startMin), end: hhmm(Math.min(startMin + 120, DAY_END)) };
    if (ADMIN) openShiftForm(undefined, prefill); else openRequestForm(prefill);
  }
});

/* ---------- start ---------- */
if (profile) {
  try {
    await load();
    render();
  } catch (err) {
    document.getElementById('weeks').innerHTML = '';
    toast(errorText(err));
  }
}
