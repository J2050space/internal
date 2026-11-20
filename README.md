# J2050 Team Management

Internal web tool of the J2050 team (University of Padova): project Gantt, document register and laboratory shift booking.

Site: <https://j2050space.github.io/internal/> (login required).

## Architecture

| Component | Service | Content |
|---|---|---|
| Web pages (HTML, CSS, JavaScript) | GitHub Pages, repository `J2050space/internal` | Static files of this repository; no build step |
| Database, authentication | Supabase project "J2050 Team Management" (EU region) | PostgreSQL with Row Level Security; e-mail and password login |
| Notification service | Supabase Edge Function `notify`, run every minute by `pg_cron` | Calendar invitations, reminders; notices on accounts, shift requests, tasks and documents |
| E-mail sending | Gmail account `j2050space@gmail.com` (SMTP, app password) | Authentication e-mails and notifications |

All rules (permissions, capacity, overlaps, supervision, codes, dates) are enforced in the database.
The pages only check inputs to give clear messages before sending.

## Pages

| Page | Users | Content |
|---|---|---|
| `index.html`, `register.html`, `welcome.html`, `forgot.html`, `reset.html` | everyone | Login, registration (only `@studenti.unipd.it` and `@unipd.it`), first access, password reset |
| `shifts.html` | active members | Lab shifts: two weekly grids, half-hour slots 08:30-18:30, booking, shift requests |
| `gantt.html` | active members (editing: admins) | Project Gantt, task editor, timeline events, review milestones |
| `documents.html` | active members (rights below) | Document register, versions and ESA deliveries, documents required per milestone, review queue |
| `account.html` | active members | Name and password |
| `stats.html` | admins | Booked hours of ended shifts, by person and by task |
| `members.html` | admins | Approval of registrations, roles, department leaders |

Every page has a "?" button with its guide, and the fields of the forms have a "?" with their meaning.
All texts are in `js/help.js` (`PAGES`: guide of each page; `FIELDS`: help of each field, keyed by the id of the control):
update them when a page or a field changes.

## Roles

| Role | Rights |
|---|---|
| `user` | Books lab slots as participant, requests shifts, reads the Gantt |
| `teamleader` | As `user`; can be leader of a department or of a task |
| `admin` | Everything: Gantt editing, shifts, approvals, members. Always supervisor in the lab (not counted in the capacity) |

A new account is `pending` until an admin approves it in `members.html`.

## Planning model (Gantt)

- Task code generated on creation: `<department>-<nn>` (e.g. `ELE-01`); subtask `<parent>.<n>` (e.g. `ELE-01.2`).
  Numbers are never reused. Code, parent and department of a top-level task cannot be changed.
- Departments: SYS, ELE, SFW, AOCS, THS, TTC, OUT, MGT.
- Dates: planned start and end (the bar), optional deadline (the gap is the margin), actual start and completion dates.
- Status derived from the dates: Planned, Not started (late), In progress, Overdue, Done; plus Blocked (manual, with reason) and At risk (planned end after the deadline, or deadline passed).
- A task with subtasks takes dates and progress from its subtasks.
- Default leader: leader of the task department, then leader of the parent task; an admin can set a different leader on the task.
- Review milestones (PDR, CDR, ...) are edited in `documents.html` and shown as vertical lines in the Gantt.

## Documents

- File name according to the J2050 Documentation Manual: `[SUBTEAM]_[TYPE]_[Title]_VXX` (e.g. `TTC_AREP_LinkBudget_V00`).
  Subteam codes: the departments plus `RED` (whole team, RedPill as a whole). Type codes as in the manual, plus `LOG` (logbooks and histories of an item). Subteam, type and title are fixed after the first approved version.
- One responsible per document (active teamleader or admin); other subteams and people can be involved.
- Links: the SharePoint folder and the working file (Word, Excel; one for all versions) on the document, the PDF on each version.
  An approved version is frozen, also for admins: changes go in the next version (an admin can reset a version, with history).
- Versions V00, V01, ... (the first version can start from another number, to continue the numbering of a document started on SharePoint): In progress → In review → Approved (admins) → Sent to ESA (link to the ESA SharePoint copy) → Accepted by ESA, or ESA changes required (comments). An admin can return a version in review with a note.
- Rights: new documents by teamleaders (who become responsible) and admins; document and versions by the responsible and admins; approval, milestones and required documents by admins.
- Required documents: document × milestone with level (draft, release, update, ad hoc), optional Gantt task that produces it, version that fulfils it.
  The milestone view shows deliveries without a task or with a task ending after the data package is due.

## Database migrations

The database is built by running the scripts of `db/` **in order**, once each, in Supabase > SQL Editor.
Each script runs as a single transaction.

| Script | Content |
|---|---|
| `schema.sql` | Base tables, Row Level Security, atomic booking |
| `002_registration_and_requests.sql` | Self-registration, approval, shift requests |
| `003_gantt_tasks.sql` | Gantt fields, import of the first Gantt (removed by 009) |
| `004_timeline_events.sql` | Timeline events |
| `005_roles_leaders_notifications.sql` | Teamleader role, leaders, statistics, notification support |
| `006_schedule_notify.sql` | Schedule of the notification service (**contains placeholders: never commit real values**) |
| `007_half_hour_slots.sql` | Bookings by half-hour slots, supervisors |
| `008_gantt_editing.sql` | Atomic task save, concurrent-change check, change history |
| `009_gantt_reset_new_model.sql` | Gantt reset, task codes, new date and status model |
| `010_documents.sql` | Documents, versions, milestones, required documents, history; department THM renamed THS; `tasks.milestone_label` removed |
| `011_documents_seed.sql` | Milestones (ESA deadline keys D1.10-D2.80, E1, E2), documents of the FYS4 Phase D and environmental testing DRDs, of the Satellite Project File DRD and of the former SharePoint tracker, required level per milestone |
| `012_documents_spf_annexes.sql` | Only for the production database (created with the former 010-013): working file link, frozen approved versions, annexes of the Satellite Project File. A new database needs only 010 and 011 |
| `013_notification_events.sql` | Queue of the events notified by e-mail (accounts, department leaders, shift requests, document reviews and responsibles), filled by triggers |
| `014_approve_past_requests.sql` | A shift request can be approved also after its start (hours worked, approval forgotten); "Add supervisor" also on past hours |

Project settings assumed: "Automatically expose new tables" disabled, "Enable automatic RLS" enabled.
New tables therefore need explicit `grant` statements and Row Level Security policies.

Rule for changes: never modify an applied script; write a new numbered script.
Test it first on a separate test project when possible.

## Configuration

`js/config.js` contains the Supabase project URL and the **publishable (anon) key**, which is public by design.
The **secret / service_role key must never appear in this repository.**

Secrets are stored in the team password manager (entry names, not values):

- Supabase organisation owners and database password;
- Gmail `j2050space@gmail.com` and its app password for SMTP;
- `NOTIFY_SECRET` of the notification service.

Edge Function secrets (Supabase > Edge Functions > Secrets): `SMTP_USER`, `SMTP_PASS`, `NOTIFY_SECRET`, `SITE_URL`.

## Notification service

Code: `supabase/functions/notify/index.ts`. Deployed manually in Supabase > Edge Functions, with JWT verification disabled
(access protected by `NOTIFY_SECRET`). Activation steps and useful commands are in `db/006_schedule_notify.sql`.
The code contains only ASCII characters (`–` for the dash), so that copying it into the dashboard editor cannot
alter it. To copy it in Windows PowerShell: `Get-Content -Raw -Encoding UTF8 <file> | Set-Clipboard`.

E-mails sent (sender `j2050space@gmail.com`, plain text). The person who caused an event never receives its e-mail.

| Area | When | To |
|---|---|---|
| Lab shifts | Booking created, changed or cancelled; shift changed or deleted (calendar invitation `.ics`) | The person booked |
| Lab shifts | 1 hour before the own booked hours | The person booked |
| Lab shifts | New shift request | Admins |
| Lab shifts | Shift request rejected, with the reason | The requester |
| Accounts | Registration confirmed and awaiting approval | Admins |
| Accounts | Account approved, rejected, disabled, re-enabled; role changed | The member |
| Accounts | Leader of a department named, changed or removed | New and former leader |
| Gantt | Tasks assigned as leader, or taken away: once a day from 07:00, net changes of the day before | New and former leader |
| Gantt | Task due in 7 days and tomorrow (deadline, or planned end), from 07:00 | Task leader |
| Gantt | Day after the due date, task not completed (due dates of the last 7 days) | Task leader and admins |
| Documents | Version sent for review | Admins |
| Documents | Version approved, or returned with a note | Responsible and submitter |
| Documents | Responsible of a document set | The new responsible |
| Documents | 14, 7 and 1 days before the data package of a milestone (or its review), required documents not yet sent to ESA | Responsible; summary to admins and SYS leader |

Notices for admins (new registrations, shift requests, overdue tasks, versions for review, documents due) go to the
admins who ticked them in `account.html` > E-mails for admins (default: all). A notice nobody ticks goes to all the admins.
An admin who does not receive a summary still gets the notices about their own tasks and documents.
The note of the admin who approves a shift request is in the requester's calendar invitation.

Confirmation of the registration and password reset e-mails are sent by Supabase Auth (Authentication > Emails),
through the same Gmail account.

Each mail is sent once: scheduled notices are recorded in `notification_log`; events are queued in
`notification_queue` by database triggers and removed when sent (an event that fails 5 times stays there with its error).

Calendar invitations and event notices wait until the shift or the object has had no change for 5 minutes, then only
the net change is sent: a mistake corrected within 5 minutes sends nothing, and A -> B -> A sends nothing.

## Operations

- **Backup**: the free Supabase plan gives no restore guarantee. Export the Gantt (Export CSV) and the main tables regularly to SharePoint.
- **Inactivity**: free projects are paused after a period without activity; resume from the Supabase dashboard.
- **Ownership**: Supabase organisation, GitHub organisation and Gmail account shall each have at least two owners.
- **Personal data**: names, e-mail addresses and lab hours of the members are stored; the team is informed of it.
