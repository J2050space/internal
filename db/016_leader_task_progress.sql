-- =====================================================================
-- J2050 internal tools - migration 016
-- Scope: the leader of a task updates the progress of the task without an
-- admin: started / completed (with dates), blocked (with reason) and note.
-- Leader = effective leader of the task (view task_leaders: leader set on
-- the task, otherwise department leader, otherwise leader of the parent),
-- or effective leader of its parent task.
-- Planned dates, deadline, leader, dependencies and structure stay with the
-- admins (admin_save_task). A task with subtasks takes its progress from the
-- subtasks: for it only the note can be changed.
-- Same concurrent-change check as admin_save_task (p_expected); the change
-- is recorded in task_history by the existing trigger.
-- Prerequisite: migrations 001-015 applied.
-- Run in Supabase > SQL Editor. Runs as one transaction; it can be run
-- again (create or replace only).
-- =====================================================================
begin;

create or replace function public.leader_set_progress(
  p_id       bigint,
  p_fields   jsonb,
  p_expected timestamptz default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_parent    bigint;
  v_current   timestamptz;
  v_children  boolean;
  v_today     date := (now() at time zone 'Europe/Rome')::date;
  v_started   date := nullif(p_fields ->> 'started_on', '')::date;
  v_completed date := nullif(p_fields ->> 'completed_on', '')::date;
  v_blocked   boolean := coalesce((p_fields ->> 'blocked')::boolean, false);
begin
  if not public.is_active() then raise exception 'Account not active'; end if;

  select parent_id, updated_at into v_parent, v_current from tasks where id = p_id for update;
  if not found then raise exception 'Task not found'; end if;

  if not public.is_admin() and not exists (
    select 1 from task_leaders tl
    where tl.task_id in (p_id, v_parent) and tl.leader_id = auth.uid()
  ) then
    raise exception 'Not the task leader';
  end if;

  if p_expected is not null and v_current <> p_expected then
    raise exception 'Task modified by someone else';
  end if;
  if v_started > v_today or v_completed > v_today then
    raise exception 'Actual dates cannot be in the future';
  end if;

  v_children := exists (select 1 from tasks where parent_id = p_id);
  update tasks set
    started_on     = case when v_children then started_on   else v_started end,
    completed_on   = case when v_children then completed_on else v_completed end,
    blocked        = case when v_children then false else v_blocked end,
    blocked_reason = case when v_children or not v_blocked then null
                          else nullif(trim(p_fields ->> 'blocked_reason'), '') end,
    note           = nullif(trim(p_fields ->> 'note'), '')
  where id = p_id;
end $$;

revoke execute on function public.leader_set_progress(bigint, jsonb, timestamptz) from public, anon;
grant  execute on function public.leader_set_progress(bigint, jsonb, timestamptz) to authenticated;

commit;
