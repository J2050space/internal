# J2050 Team Management

Internal web tool of the J2050 team (University of Padova): project Gantt, document register and laboratory shift booking.

Site: <https://j2050space.github.io/internal/> (login required).

## Architecture

| Component | Service | Content |
|---|---|---|
| Web pages (HTML, CSS, JavaScript) | GitHub Pages, repository `J2050space/internal` | Static files of this repository; no build step |
| Database, authentication | Supabase project "J2050 Team Management" (EU region) | PostgreSQL with Row Level Security; e-mail and password login |
| Notification service | Supabase Edge Function `notify`, run every minute by `pg_cron` | Calendar invitations, reminders, task and registration notices |
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
- Versions V00, V01, ...: In progress → In review → Approved (admins) → Sent to ESA (link to the ESA SharePoint copy) → Accepted by ESA, or ESA changes required (comments). An admin can return a version in review with a note.
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
| `011_documents_seed.sql` | Initial milestones and documents required by ESA (draft timeline, replaced by 012) |
| `012_documents_fys4_phase_d.sql` | Milestones (ESA deadline keys D1.10-D2.80, E1, E2) and documents required by the FYS4 Phase D DRDs; replaces the data of 011 |

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

## Operations

- **Backup**: the free Supabase plan gives no restore guarantee. Export the Gantt (Export CSV) and the main tables regularly to SharePoint.
- **Inactivity**: free projects are paused after a period without activity; resume from the Supabase dashboard.
- **Ownership**: Supabase organisation, GitHub organisation and Gmail account shall each have at least two owners.
- **Personal data**: names, e-mail addresses and lab hours of the members are stored; the team is informed of it.
