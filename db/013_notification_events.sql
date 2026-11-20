-- =====================================================================
-- J2050 internal tools - migration 013
-- Scope: queue of the events notified by e-mail (read by the "notify"
-- Edge Function, which sends the e-mails and removes the events), and
-- e-mail preferences of the admins.
--   * account_status   profile status changed (approved, rejected,
--                      disabled, re-enabled)            -> the member
--   * account_role     role of an active member changed -> the member
--   * team_leader      leader of a department set, changed or removed
--                                                       -> new and former leader
--   * shift_request    new shift request                -> admins
--   * request_rejected shift request rejected           -> the requester
--   * doc_submitted    document version sent for review -> admins
--   * doc_approved     version approved                 -> responsible, submitter
--   * doc_returned     version returned with a note     -> responsible, submitter
--   * doc_responsible  responsible of a document set    -> the new responsible
-- The person who caused the event (actor) never receives its e-mail.
-- The Edge Function waits until an object has had no change for 5 minutes
-- and notifies only the net change (A -> B -> A: no e-mail).
-- Scheduled notices (task deadlines and overdue tasks, documents due for a
-- milestone) need no event: the Edge Function reads the dates.
-- Preferences of the admins (account page): each admin chooses which notices
-- "for admins" to receive (registrations, shift requests, overdue tasks,
-- versions for review, documents due). Notices about the admin's own
-- shifts, tasks and documents always arrive. A notice muted by every admin
-- is sent to all the admins, so that it is never lost.
-- Prerequisite: migrations 001-011 applied (independent of 012).
-- Run once in Supabase > SQL Editor. Runs as one transaction.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. Queue
-- ---------------------------------------------------------------------
create table public.notification_queue (
  id          bigint generated always as identity primary key,
  kind        text not null,
  payload     jsonb not null default '{}',
  actor_id    uuid,                         -- auth.uid() of who caused the event
  created_at  timestamptz not null default now(),
  attempts    integer not null default 0,   -- failed sending attempts
  last_error  text
);

alter table public.notification_queue enable row level security;
-- No policies and no grants: not accessible from the site.

create function private.queue_event(p_kind text, p_payload jsonb) returns void
language sql security definer set search_path = public as $$
  insert into notification_queue (kind, payload, actor_id) values (p_kind, p_payload, auth.uid());
$$;

-- ---------------------------------------------------------------------
-- 2. Accounts: status and role
-- ---------------------------------------------------------------------
create function public.queue_profile_event() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status then
    perform private.queue_event('account_status',
      jsonb_build_object('user_id', new.id, 'from', old.status, 'to', new.status));
  elsif new.role is distinct from old.role and new.status = 'active' then
    perform private.queue_event('account_role',
      jsonb_build_object('user_id', new.id, 'from', old.role, 'to', new.role));
  end if;
  return null;
end $$;

create trigger profiles_notify after update of status, role on public.profiles
  for each row execute function public.queue_profile_event();

-- ---------------------------------------------------------------------
-- 3. Department leaders
-- ---------------------------------------------------------------------
create function public.queue_team_leader_event() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_from uuid := case when tg_op <> 'INSERT' then old.leader_id end;
  v_to   uuid := case when tg_op <> 'DELETE' then new.leader_id end;
begin
  if v_from is distinct from v_to then
    perform private.queue_event('team_leader', jsonb_build_object(
      'team', case when tg_op = 'DELETE' then old.team else new.team end, 'from', v_from, 'to', v_to));
  end if;
  return null;
end $$;

create trigger team_leaders_notify after insert or update or delete on public.team_leaders
  for each row execute function public.queue_team_leader_event();

-- ---------------------------------------------------------------------
-- 4. Shift requests
-- ---------------------------------------------------------------------
create function public.queue_request_event() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' and new.status = 'pending' then
    perform private.queue_event('shift_request', jsonb_build_object('request_id', new.id));
  elsif tg_op = 'UPDATE' and old.status = 'pending' and new.status = 'rejected' then
    perform private.queue_event('request_rejected', jsonb_build_object('request_id', new.id));
  end if;
  return null;
end $$;

create trigger shift_requests_notify after insert or update of status on public.shift_requests
  for each row execute function public.queue_request_event();

-- ---------------------------------------------------------------------
-- 5. Documents: review of the versions, responsible
--    (withdrawing a version from review is not notified)
-- ---------------------------------------------------------------------
create function public.queue_version_event() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_kind text;
begin
  v_kind := case
    when old.status = 'in_progress' and new.status = 'in_review' then 'doc_submitted'
    when old.status = 'in_review' and new.status = 'approved' then 'doc_approved'
    when old.status = 'in_review' and new.status = 'in_progress' and new.review_note is not null then 'doc_returned'
  end;
  if v_kind is not null then
    perform private.queue_event(v_kind, jsonb_build_object('version_id', new.id));
  end if;
  return null;
end $$;

create trigger document_versions_notify after update of status on public.document_versions
  for each row execute function public.queue_version_event();

-- Every change is queued, also the removal of the responsible: the Edge
-- Function compares the first and the last change of a document and
-- notifies only the net change.
create function public.queue_responsible_event() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_from uuid := case when tg_op = 'UPDATE' then old.responsible_id end;
begin
  if new.responsible_id is distinct from v_from then
    perform private.queue_event('doc_responsible',
      jsonb_build_object('document_id', new.id, 'from', v_from, 'to', new.responsible_id));
  end if;
  return null;
end $$;

create trigger documents_notify after insert or update of responsible_id on public.documents
  for each row execute function public.queue_responsible_event();

-- ---------------------------------------------------------------------
-- 6. Preferences of the admins: notices for admins they do not receive
--    (a new admin receives all of them)
-- ---------------------------------------------------------------------
create function private.admin_notices() returns text[]
language sql immutable as $$
  select array['registrations', 'shift_requests', 'tasks_overdue', 'doc_review', 'doc_due'];
$$;

create table public.notification_prefs (
  user_id     uuid primary key references public.profiles(id) on delete cascade,
  muted       text[] not null default '{}' check (muted <@ private.admin_notices()),
  updated_at  timestamptz not null default now()
);

alter table public.notification_prefs enable row level security;
-- Admins see the choices of all the admins (who receives what); they
-- change only their own, through set_notification_prefs.
create policy read_notification_prefs on public.notification_prefs for select to authenticated
  using (public.is_admin());

create function public.set_notification_prefs(p_muted text[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (public.is_admin() and public.is_active()) then raise exception 'Not authorized'; end if;
  if not coalesce(p_muted, '{}') <@ private.admin_notices() then raise exception 'Unknown notice'; end if;
  insert into notification_prefs (user_id, muted) values (auth.uid(), coalesce(p_muted, '{}'))
  on conflict (user_id) do update set muted = excluded.muted, updated_at = now();
end $$;

-- ---------------------------------------------------------------------
-- 7. Privileges
-- ---------------------------------------------------------------------
revoke all on function private.queue_event(text, jsonb) from public;
grant execute on function private.admin_notices() to authenticated, service_role;

grant select on public.notification_prefs to authenticated, service_role;
revoke execute on function public.set_notification_prefs(text[]) from public, anon;
grant  execute on function public.set_notification_prefs(text[]) to authenticated;

revoke execute on function public.queue_profile_event()     from public, anon, authenticated;
revoke execute on function public.queue_team_leader_event() from public, anon, authenticated;
revoke execute on function public.queue_request_event()     from public, anon, authenticated;
revoke execute on function public.queue_version_event()     from public, anon, authenticated;
revoke execute on function public.queue_responsible_event() from public, anon, authenticated;

-- Edge Function only (service role)
grant select, update, delete on public.notification_queue to service_role;

commit;
