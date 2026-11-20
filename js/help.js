// Help: guide of each page ("?" button) and help of the fields of the forms
// ("?" next to a label). Field help is added automatically to every label of
// the page, also inside modals opened later, when this file has a text for it.
//   Key of a field: id of the control of the label (label[for], or the control
//   inside the label); for a <span class="lbl"> the text of the label, as 'lbl:Text'.
//   Value: text, or { 'Start of the label text': text } when one id is used by
//   several forms with different meanings.

const ADMIN = '<span class="help-tag">Admins</span>';
const LEAD = '<span class="help-tag">Teamleaders</span>';

/* ====================================================================
   Page guides
   ==================================================================== */
const PAGES = {
  login: {
    title: 'Log in',
    html: `
      <p>Log in with your university email (<b>@studenti.unipd.it</b> or <b>@unipd.it</b>) and your password.</p>
      <ul>
        <li><b>Create account</b>: first access. After the confirmation email, log in, enter your name and wait for the approval of an administrator.</li>
        <li><b>Forgot password?</b>: a link to set a new password is sent by email.</li>
      </ul>`,
  },
  register: {
    title: 'Create account',
    html: `
      <ol>
        <li>Enter your <b>@studenti.unipd.it</b> or <b>@unipd.it</b> address and a password of at least 12 characters.</li>
        <li>Open the link in the confirmation email (check the spam folder).</li>
        <li>Log in and enter your first and last name.</li>
        <li>An administrator approves the account: then you can use the site.</li>
      </ol>`,
  },
  forgot: {
    title: 'Forgot password',
    html: `<p>Enter the address of your account: you receive an email with a link to the page where you choose a new password.
      The link can be used once. If the email does not arrive, check the spam folder and wait a few minutes before asking again.</p>`,
  },
  reset: {
    title: 'Set new password',
    html: `<p>This page is opened from the link in the email. Choose a password of at least 12 characters, repeat it and save:
      you are then logged in with the new password. If the page says the link is not valid, ask for a new one from <i>Forgot password?</i></p>`,
  },
  welcome: {
    title: 'Welcome',
    html: `
      <ol>
        <li><b>Your name</b>: first and last name as they will be shown to the team (shifts, Gantt, documents).</li>
        <li><b>Approval</b>: an administrator approves the account. Press <i>Check again</i> to see if it has been approved.</li>
      </ol>
      <p>A <b>disabled</b> account cannot use the site: contact an administrator.</p>`,
  },

  shifts: {
    title: 'Lab shifts',
    html: `
      <h3>What you see</h3>
      <ul>
        <li>Two weeks, Monday to Friday, 08:30–18:30. Each block is a <b>shift</b> in the lab, linked to a task of the Gantt.</li>
        <li>In a block: <b>seats</b> (highest number booked in a half-hour / capacity), time, a strip with one mark per half hour
          (free, full, without supervisor, yours), task, location, <b>Sup.</b> = supervisors, then the participants.</li>
        <li>Colours: see the legend above the calendar. Red dashed blocks are <b>shift requests</b> waiting for an administrator.</li>
        <li>Shifts outside 08:30–18:30 are listed below the week. On a phone each week is a list.</li>
      </ul>
      <h3>Toolbar</h3>
      <ul>
        <li>Arrows: previous / next week, <i>This week</i> to come back.</li>
        <li><i>Free seats only</i>, <i>My shifts only</i>, <i>Show requests</i>: filters. The circular arrow reads the data again.</li>
      </ul>
      <h3>Booking a shift</h3>
      <ul>
        <li>Click a shift, then <b>Book…</b> and choose from / to: you book only the half hours you need.</li>
        <li>A half hour can be booked only if it has a <b>supervisor</b> (an administrator) and a <b>free seat</b>.
          The capacity counts participants per half hour; supervisors are not counted.</li>
        <li>Until your booking starts: <b>Change my hours…</b> or <b>Cancel my booking</b>.</li>
      </ul>
      <h3>Requesting a shift</h3>
      <ul>
        <li><b>Request a shift</b> (or click an empty part of a future day): date, hours, work to do.</li>
        <li>An administrator approves it (the shift is created and you are booked on it) or rejects it with a reason.
          While it is pending you can <b>Withdraw</b> it.</li>
        <li>Below the calendar: pending requests outside the weeks shown, and requests handled in the last 30 days.</li>
      </ul>
      <h3>Administration ${ADMIN}</h3>
      <ul>
        <li><b>New shift</b> (or click an empty part of a future day), with its first supervisor.</li>
        <li>In a shift: <b>Edit</b> (times, task, capacity; lowering the capacity asks which participants to remove),
          <b>Join as supervisor…</b>, <b>Add supervisor…</b>, ✕ next to a booking to remove it, <b>Delete shift</b>.</li>
        <li>Remove participants who did not come, also after the shift: Stats counts the booked hours.</li>
        <li><b>Add supervisor…</b> lists all the admins: choosing one already booked changes his/her hours (e.g. extend
          them to cover slots without supervisor).
          It works also after the shift, to record who supervised: to replace a supervisor,
          add the right one, then remove the wrong booking with ✕.</li>
        <li>Requests: <b>Approve…</b> (you can adjust hours, task and capacity) or <b>Reject</b> with a reason.
          A request can be approved also after its start, to record the hours of a member who came to the lab
          but was not approved in time.</li>
      </ul>
      <h3>Rules</h3>
      <p>Monday to Friday, 08:30–18:30, start and end on :00 or :30, start in the future
        (except when an admin approves a request after its start).</p>`,
  },

  gantt: {
    title: 'Gantt',
    html: `
      <h3>Views</h3>
      <ul>
        <li><b>Gantt</b>: bars on the calendar. <b>Table</b>: all fields in columns. <b>Departments</b>: tasks of one department
          (owner) or in which it takes part (involved), with its leader.</li>
        <li><b>This week</b>: lists for the board meeting (blocked, overdue, deadlines in 7 days, late starts, starts in 7 days).</li>
        <li><b>Timeline events</b>: fixed external dates (launch, ESA deadlines, exams…), shown as vertical lines. ${ADMIN} edit them in place.</li>
      </ul>
      <h3>Counters at the top</h3>
      <p>Done, in progress, overdue, late start, blocked, at risk, open tasks without a leader, and the days to the next reviews
        (milestones of the Documents page).</p>
      <h3>Toolbar</h3>
      <ul>
        <li><i>Department</i>: tasks of a department, including those in which it is involved. <i>Search</i>: code, activity, leader, people.</li>
        <li>− / + zoom; double arrows: expand / collapse all subtasks (or the arrow next to a task); <i>Hide done</i>.</li>
        <li>Download icon: <i>Export CSV</i> of all tasks, for Excel (separator ;). Circular arrow: reads the data again.</li>
      </ul>
      <h3>Reading the Gantt</h3>
      <ul>
        <li>Bar = planned start → planned end, coloured by status. Thin bar = task with subtasks: its dates come from the subtasks.</li>
        <li>Diamond = deadline; the dotted segment between the end of the bar and the deadline is the <b>margin</b>.</li>
        <li>Arrows = dependencies; red dashed when a task starts before the end of the task it depends on.</li>
        <li>Vertical lines: today, review milestones (code at the top; hover for the dates) and timeline events.</li>
      </ul>
      <h3>Status (calculated)</h3>
      <ul>
        <li><b>Planned</b> → <b>Not started (late)</b> if the planned start has passed → <b>In progress</b> when started →
          <b>Overdue</b> if the planned end has passed → <b>Done</b> when completed.</li>
        <li><b>Blocked</b>: set by hand with a reason. <b>At risk</b>: planned end after the deadline, or deadline passed.</li>
      </ul>
      <h3>Codes and leaders</h3>
      <ul>
        <li>Codes are assigned automatically and never change: <span class="mono">SYS-03</span>, subtasks <span class="mono">SYS-03.2</span>.</li>
        <li>Leader of a task: the one chosen on the task, otherwise the leader of its department (set in Members), otherwise the leader of the parent task.</li>
      </ul>
      <h3>Editing ${ADMIN}</h3>
      <ul>
        <li><b>New task</b>, or click a task to edit it: dates, leader, progress, dependencies, subtasks, <i>Duplicate</i>, <i>Delete…</i>.</li>
        <li><b>Edit timeline</b>: drag a bar to move it (subtasks included), drag its ends to change start or end; Esc cancels;
          <i>Undo</i> appears for 10 seconds after each change.</li>
        <li>If someone else saved the same task in the meantime, the save is refused: reload and repeat.</li>
        <li>Every change is recorded: <i>Change history</i> at the bottom of the task.</li>
      </ul>
      <p>The other members see the tasks read only. <b>Deliverables</b> in a task: documents it has to produce for a review,
        linked in Documents › Milestones.</p>`,
  },

  documents: {
    title: 'Documents',
    html: `
      <p>Register of the project documents (ESA Fly Your Satellite), their versions and what has to be delivered at each review.</p>
      <h3>File name</h3>
      <p><span class="mono">[SUBTEAM]_[TYPE]_[Title]_VXX</span>, as in the J2050 Documentation Manual (e.g. <span class="mono">TTC_AREP_LinkBudget_V02</span>).
        The site shows the name of the version being worked on: use <i>Copy name</i> in the document to name the file.</p>
      <h3>Views</h3>
      <ul>
        <li><b>Register</b>: all documents, status of the last version, responsible and next delivery.</li>
        <li><b>Milestones</b>: documents × reviews. Symbols: ◌ draft, ● release, ⊗ update, AH ad hoc; the colour is the state of the
          delivery (legend above the table). Bottom row: delivered / required, deliveries without a task, tasks ending late.
          <i>Only problems</i> keeps the documents with late, close or uncovered deliveries.</li>
        <li><b>Review</b>: versions waiting for approval, approved versions to send to ESA, ESA changes required, deliveries late or due within 21 days.</li>
        <li>Counters at the top: documents, versions to approve, late deliveries, days to the next data package.</li>
        <li>Filters: search (name, ESA code, responsible), subteam (also involved), status, <i>My documents</i> (you are responsible).</li>
      </ul>
      <h3>Versions</h3>
      <ol>
        <li><b>Start first version</b>: usually V00; a document already started on SharePoint continues its numbering (e.g. V04 after V03).
          Then <b>Start V01</b>, V02, …: version <i>In progress</i>. You work on the <b>working file</b> (Word, Excel) linked in the document.</li>
        <li>Export the PDF of the version and <b>Submit for review</b> with its link (required): the reviewer checks that PDF. <i>Withdraw</i> brings it back in progress.</li>
        <li>An administrator <b>Approves</b> it, or <b>Returns</b> it with what has to be changed.</li>
        <li><b>Sent to ESA</b>: date, link to the copy on the ESA SharePoint, and the milestones this version fulfils.</li>
        <li><b>ESA outcome</b>: <i>Accepted by ESA</i>, or <i>Changes required</i> with the ESA comments, to address in the next version.</li>
      </ol>
      <p>An <b>approved</b> version is frozen, also for administrators: its PDF stays as approved. Only the ESA link and comments can still be added. Changes go in the next version: after approving V02, rename the working file to V03 in place (the link stays valid) and start V03. An administrator can <i>Reset</i> a version (recorded in the history) to correct an error.</p>
      <p>Quick links in the Register and at the top of a document: <b>Edit</b> = working file, <b>PDF</b> = last approved version, <b>Folder</b>.</p>
      <p>Subteam, type and title are fixed after the first approved version.</p>
      <h3>Deliveries and Gantt</h3>
      <ul>
        <li>Each document can be required at one or more milestones. Due date = <i>data package due</i> of the milestone, or its review date.</li>
        <li>States: <i>To deliver</i>, <i>Due soon</i> (21 days), <i>Late</i>, <i>Delivered</i>, <i>Delivered, ESA changes required</i>, <i>Ad hoc</i> (no date), <i>Waived</i>.</li>
        <li>Link each delivery to the <b>task of the Gantt</b> that produces it: <b>!</b> means no task, or a task ending after the due date.</li>
      </ul>
      <h3>Who does what</h3>
      <ul>
        <li>Everybody reads everything. The <b>responsible</b> of a document edits it and moves its versions.</li>
        <li>${LEAD} create documents (they become responsible). ${ADMIN} do everything, and only they approve versions,
          change the responsible, edit milestones (click the code at the top of a column) and required documents (click a cell, or + on an empty one).</li>
        <li><i>History</i> at the bottom of a document: every change, with who and when.</li>
      </ul>`,
  },

  stats: {
    title: 'Stats',
    html: `
      <p>Hours booked in lab shifts already ended: participants and supervisors. Only administrators see this page.</p>
      <ul>
        <li><b>From / To</b> or the quick periods (last 30 days, this month, all). <b>Department</b>: tasks of that department or in which it is involved.</li>
        <li><b>By person</b>: hours, of which supervising, number of shifts, main tasks.</li>
        <li><b>By task</b>: hours per task; the hours of the subtasks are added to their parent task.</li>
        <li><b>Person × task</b>: hours of each person on each task (hover a code for the task name).</li>
        <li>Download icon (<b>Export CSV</b>): one row per person, task and role, for Excel.</li>
      </ul>
      <p>The hours are the booked ones: remove from the shift the participants who did not come (Lab shifts, also after the shift).</p>`,
  },

  members: {
    title: 'Members',
    html: `
      <p>Accounts of the team. Only administrators see this page.</p>
      <ul>
        <li><b>Awaiting approval</b>: confirmed email and name entered. <i>Approve</i> to let them in, <i>Reject</i> to disable the account.</li>
        <li><b>Department leaders</b>: default leader of the tasks of each department in the Gantt (an active teamleader or admin).</li>
        <li><b>Active members</b>: change the <b>role</b> or <i>Disable</i> the account. <b>Disabled</b>: <i>Re-enable</i>.</li>
        <li><b>Email not confirmed yet</b>: they never opened the confirmation link. Wrong accounts are deleted in Supabase › Authentication › Users.</li>
      </ul>
      <h3>Roles</h3>
      <ul>
        <li><b>User</b>: books lab shifts and requests them, reads Gantt and documents.</li>
        <li><b>Teamleader</b>: as user, can also be leader of a department or task and responsible of documents, and creates documents.</li>
        <li><b>Admin</b>: everything, including approvals, Gantt editing, shifts, milestones, Stats and Members.</li>
      </ul>
      <p>You cannot change your own account, and at least one active administrator is always kept.</p>`,
  },

  account: {
    title: 'Account',
    html: `
      <ul>
        <li><b>Profile</b>: your first and last name as shown to the team. The email cannot be changed.</li>
        <li><b>Change password</b>: at least 12 characters, typed twice.</li>
        <li>${ADMIN} <b>E-mails for admins</b>: tick the notices for admins you want to receive, so that each admin
          follows only their own area (e.g. lab or Gantt). Under each notice: who receives it now. A notice nobody
          ticks is sent to all the admins. E-mails about your own shifts, tasks and documents always arrive.</li>
      </ul>`,
  },
};

/* ====================================================================
   Field help
   ==================================================================== */
const NAME = { 'first-name': 'Your first name, as shown to the team.', 'last-name': 'Your last name, as shown to the team.' };
const PASSWORD = {
  password: 'At least 12 characters. A short sentence is easier to remember than a complicated word.',
  password2: 'Type the same password again, to avoid typing errors.',
};
const EMAIL = { email: 'Your university address: @studenti.unipd.it or @unipd.it.' };

const FIELDS = {
  login: { ...EMAIL, password: 'The password of your account. Forgotten? Use "Forgot password?" below.' },
  register: { ...EMAIL, ...PASSWORD },
  forgot: { email: 'The address of your account: the link to set a new password is sent here.' },
  reset: PASSWORD,
  welcome: NAME,
  account: { ...NAME, ...PASSWORD },

  stats: {
    from: 'First day of the period. Only shifts already ended are counted.',
    to: 'Last day of the period.',
    team: 'Only the tasks of this department, or tasks in which it is involved.',
  },

  shifts: {
    'b-user': 'Another administrator to book as supervisor of this shift.',
    'b-from': 'First half hour you book. The list below shows the state of each half hour.',
    'b-to': 'End of your booking. A participant can book only half hours with a supervisor and a free seat.',
    'f-sup': 'Administrator who supervises the shift: booked on the whole shift, not counted in the capacity. Other administrators can join later.',
    'f-date': 'Day of the shift: Monday to Friday, in the future.',
    'f-start': 'Start time, between 08:30 and 18:30, on :00 or :30.',
    'f-end': 'End time, after the start, at most 18:30.',
    'f-task': {
      'Task of the Gantt': 'Optional: the task of the Gantt the work belongs to. The administrator chooses the final task when approving.',
      Task: 'Task of the Gantt the work belongs to. The hours of the shift are counted under this task in Stats.',
    },
    'f-cap': 'Maximum number of participants in each half hour (1–50). Supervisors are not counted. Lowering it below the current bookings asks which participants to remove.',
    'f-loc': 'Lab or room where the shift takes place.',
    'f-desc': 'What will be done in the shift, so that the others know if they can help.',
    'f-notes': 'Other information: what to bring, access, safety…',
    'f-note': {
      'Note to the requester': 'Optional message for the requester, shown with the outcome of the request.',
      Reason: 'Why the request is rejected. Shown in the list of handled requests.',
    },
  },

  gantt: {
    'lbl:Code': 'Assigned automatically when the task is created: department + number (SYS-03); subtasks take the code of the parent + .n (SYS-03.2). It never changes.',
    'ed-dept': 'Department that owns the task. Its leader is the default leader of the task. For a top-level task it is part of the code, so it cannot be changed after creation.',
    'lbl:Parent task': 'Task this one is a subtask of. Subtasks are created with "Add subtask" in the parent task; there is only one level of subtasks.',
    'ed-name': 'Short description of the work (max 200 characters).',
    'ed-start': 'Planned start: beginning of the bar. When it has passed and the task is not started, the status is "Not started (late)". For a task with subtasks it is calculated.',
    'ed-end': 'Planned end: end of the bar. When it has passed and the task is not completed, the status is "Overdue". For a task with subtasks it is calculated.',
    'ed-deadline': 'Optional date by which the task must be completed (a review, another team waiting…). Margin = deadline − planned end. Planned end after the deadline, or deadline passed: "At risk".',
    'ed-leader': '"Default" is the leader of the department (set in Members) or of the parent task. Choose a name only to give this task a different leader. Only active teamleaders and admins.',
    'ed-people': 'Who works on the task, also people without an account. Free text, included in the search.',
    'lbl:Other departments involved': 'The task also appears under these departments in the filter and in the Departments view ("involved").',
    'ed-note': 'Short note, shown in the Table view and in the tooltip of the bar (max 500 characters).',
    'ed-started': 'Tick when the work actually begins; the date is the actual start (today by default, not in the future).',
    'ed-completed': 'Tick when the work is finished; the date cannot be in the future nor before the start. A completed task is "Done".',
    'ed-blocked': 'The task cannot go on (parts missing, waiting for another team…). The reason is required and shown in the This week view.',
    'lbl:Depends on': 'Tasks that must end before this one starts. Shown as arrows; a warning appears if this task starts before they end.',
    'lbl:Required by': 'Tasks that can start only after this one ends: the same link seen from the other side.',
  },

  documents: {
    'e-sub': 'Subteam that owns the document: first block of the file name. RED = the whole RedPill satellite or team. Fixed after the first approved version.',
    'e-type': 'Type code of the Documentation Manual: second block of the file name. Choose it by the purpose of the content, not by the file format. Fixed after the first approved version.',
    'e-title': 'Third block of the file name: 2–5 English words joined, each with a capital initial, no spaces or underscores (e.g. LinkBudget). Fixed after the first approved version.',
    'e-name': 'Full title, as on the cover page of the document.',
    'e-esa': 'Code of the ESA deliverable (e.g. TS-VCD, DDJF). Empty for internal documents.',
    'e-resp': 'The one person accountable for the document: an active teamleader or admin. With the administrators, the only one who edits it and moves its versions. Only administrators change it.',
    'e-prio': 'Priority for the team. Informative only.',
    'e-folder': 'Link to the SharePoint folder of the document: working file, PDFs of the versions, attachments.',
    'e-work': 'Link to the file you edit (Word, Excel…). One file for all versions: after a release rename it in place to the next version, the link stays valid. Open it with "Edit".',
    'lbl:Other subteams involved': 'Subteams contributing to the document: it also appears when filtering by them.',
    'e-people': 'People writing or contributing, also without an account. Free text.',
    'e-hold': 'Work suspended. Give the reason; the document is shown as "On hold" and can be filtered.',
    'e-note': 'Free note on the document.',
    'p-num': 'Number of the first version on the site: V00 for a new document. For a document already on SharePoint, the number after its last version there (V03 there: 4). The following versions are numbered automatically.',
    'p-file': 'Link to the PDF of this version (SharePoint). Optional when starting the version, required to submit it for review. Cannot be changed after the approval.',
    'p-change': 'What changes compared with the previous version (e.g. "Updated after the CDR comments").',
    'p-note': 'What the responsible has to change before submitting the version again. Shown in the list of versions.',
    'p-sent': 'Day the version was uploaded for ESA. Not in the future.',
    'p-esa': 'Link to the copy uploaded on the ESA SharePoint. Required when the version is marked as sent.',
    'lbl:Milestones fulfilled by this version': 'Deliveries satisfied by this version: they become "Delivered". Only deliveries still open are listed.',
    'p-comments': 'Comments or changes required by ESA. Required for "Changes required"; address them in the next version.',
    'q-doc': 'Document that has to be delivered. Cannot be changed later: remove the requirement and add a new one.',
    'q-ms': 'Review at which it has to be delivered. Cannot be changed later: remove the requirement and add a new one.',
    'q-level': '◌ Draft: preliminary version. ● Release: first complete issue. ⊗ Update: new issue of a document already released. AH Ad hoc: kept up to date or given on request, no due date (never late, not counted in the coverage).',
    'q-ver': 'Version sent to ESA that satisfies this delivery. Normally set by "Sent to ESA"; only versions already sent are listed.',
    'q-task': 'Task of the Gantt that produces the document for this review. Without a task, or with a task ending after the data package is due, a "!" warning is shown. The task shows the document among its Deliverables.',
    'q-waived': 'No longer required (ESA waiver, delivered before this tool…). Give the reason; it is not counted any more.',
    'q-note': 'What the document must contain at this review.',
    'm-code': 'Short code of the review (capitals, digits, hyphens; e.g. CDR). Shown on the columns and on the Gantt line. It can be changed: the deliveries stay linked.',
    'm-name': 'Full name of the review.',
    'm-phase': 'Phase of the project (e.g. C, D1). Informative only.',
    'm-order': 'Position of the milestone among the others (columns of the matrix). Use steps of 10 to insert one in between.',
    'm-due': 'Date by which the documents must be delivered to ESA. It is the due date of the deliveries of this review (late, due soon, task check). Empty: the review date is used.',
    'm-review': 'Planned date of the review: vertical line in the Gantt and "Days to" counter.',
    'm-held': 'Date the review actually took place (not in the future): the milestone is shown as concluded and the Gantt line moves to this date.',
    'm-note': 'What is expected at this review.',
  },
};

/* ====================================================================
   Mechanics
   ==================================================================== */
let PAGE = null;
let dlg = null;
let pop = null;
let popFor = null;

// Text of a label without the text of the controls inside it
const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE)
  .map((n) => n.textContent).join(' ').replace(/\s+/g, ' ').trim();

function fieldText(el) {
  const dict = FIELDS[PAGE];
  if (!dict) return null;
  let key;
  if (el.matches('.lbl')) key = `lbl:${ownText(el)}`;
  else key = el.htmlFor || el.querySelector('input[id], select[id], textarea[id]')?.id;
  const v = key ? dict[key] : null;
  if (!v || typeof v === 'string') return v ?? null;
  const text = ownText(el);
  const hit = Object.keys(v).find((k) => text.startsWith(k));
  return hit ? v[hit] : null;
}

function decorate(root = document) {
  root.querySelectorAll('label:not([data-fh]), .lbl:not([data-fh])').forEach((el) => {
    el.dataset.fh = '';
    const text = fieldText(el);
    if (!text) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fh';
    b.textContent = '?';
    b.setAttribute('aria-label', `Help: ${ownText(el) || 'field'}`);
    b.setAttribute('aria-expanded', 'false');
    b.helpText = text;
    el.appendChild(b);
  });
}

function closePop() {
  if (!pop || pop.hidden) return;
  pop.hidden = true;
  popFor?.setAttribute('aria-expanded', 'false');
  popFor = null;
}

function openPop(button) {
  if (!pop) {
    pop = document.createElement('div');
    pop.id = 'fh-pop';
    pop.setAttribute('role', 'tooltip');
    pop.hidden = true;
    document.body.appendChild(pop);
  }
  if (popFor === button) { closePop(); return; }
  closePop();
  pop.textContent = button.helpText;
  pop.hidden = false;
  popFor = button;
  button.setAttribute('aria-expanded', 'true');
  button.setAttribute('aria-describedby', 'fh-pop');
  // Below the button, inside the window
  const r = button.getBoundingClientRect();
  const w = Math.min(320, window.innerWidth - 16);
  pop.style.width = `${w}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left - 12, window.innerWidth - w - 8))}px`;
  const h = pop.offsetHeight;
  const below = r.bottom + 6;
  pop.style.top = `${below + h > window.innerHeight - 8 && r.top - h - 6 > 8 ? r.top - h - 6 : below}px`;
}

function openGuide() {
  const page = PAGES[PAGE];
  if (!page) return;
  closePop();
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.className = 'help-dlg';
    dlg.setAttribute('aria-labelledby', 'help-title');
    dlg.addEventListener('click', (e) => { if (e.target === dlg || e.target.closest('[data-help-close]')) dlg.close(); });
    document.body.appendChild(dlg);
  }
  dlg.innerHTML = `<div class="help-body">
      <div class="help-head"><h2 id="help-title">Help – ${page.title}</h2>
        <button type="button" class="secondary" data-help-close aria-label="Close help">✕</button></div>
      ${page.html}
      <p class="hint help-foot">The <b>?</b> next to a field explains that field.</p>
    </div>`;
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
}

// Button "?" of the page: in the header of the protected pages, in the box of the login pages
function addPageButton() {
  if (!PAGES[PAGE] || document.getElementById('help-btn')) return;
  const b = document.createElement('button');
  b.type = 'button';
  b.id = 'help-btn';
  b.className = 'help-btn';
  b.textContent = '?';
  b.title = 'Help on this page';
  b.setAttribute('aria-label', 'Help on this page');
  b.addEventListener('click', openGuide);
  const user = document.querySelector('#app-header .user');
  if (user) user.prepend(b);
  else document.querySelector('.login-box')?.prepend(b);
}

export function initHelp(page) {
  if (PAGE) return;
  PAGE = page;
  addPageButton();
  decorate();
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; decorate(); });
  }).observe(document.body, { childList: true, subtree: true });

  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('button.fh');
    if (b) { e.preventDefault(); e.stopPropagation(); openPop(b); return; }
    if (pop && !pop.hidden && !e.target.closest?.('#fh-pop')) closePop();
  }, true);
  // Esc closes the help first, not the modal below it
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (pop && !pop.hidden) { closePop(); e.stopImmediatePropagation(); e.preventDefault(); }
    else if (dlg?.open) e.stopImmediatePropagation();
  }, true);
  window.addEventListener('scroll', closePop, true);
  window.addEventListener('resize', closePop);
}
