-- =====================================================================
-- J2050 internal tools - migration 014
-- Scope: an admin can approve a shift request also after its start (e.g.
-- the member came to the lab but the approval was forgotten). The shift is
-- created and supervisor and requester are booked also on hours already
-- passed, so that Stats counts them. All the other rules stay: half hours,
-- supervision, capacity, no overlapping bookings.
-- "Add supervisor" also works on past shifts: to replace a supervisor,
-- add the right admin and remove the wrong booking.
-- Booking past hours stays reserved to these two admin actions: own
-- bookings (members and admins) still cover only hours not yet started.
-- No calendar invitation is sent for hours already ended (notify skips
-- past shifts).
-- Prerequisite: migrations 001-009 applied.
-- Run in Supabase > SQL Editor. Runs as one transaction; it can be run
-- again (create or replace only).
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. Booking routine with the option of past hours (p_allow_past);
--    private.book keeps its behaviour (future hours only). Same checks as
--    private.book of migration 007.
-- ---------------------------------------------------------------------
create or replace function private.book_at(p_shift_id bigint, p_user_id uuid, p_starts_at timestamptz, p_ends_at timestamptz,
                                p_allow_past boolean)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_role  text;
  s       shifts%rowtype;
  v_old   assignments%rowtype;
begin
  select case when p.role = 'admin' then 'supervisor' else 'participant' end into v_role
  from profiles p where p.id = p_user_id and p.status = 'active';
  if not found then raise exception 'Member not found or not active'; end if;

  -- Serialize bookings of the same user (overlap) and of the same shift (capacity)
  perform pg_advisory_xact_lock(hashtext('book_user:' || p_user_id::text));
  select * into s from shifts where id = p_shift_id for update;
  if not found then raise exception 'Shift not found'; end if;

  if p_starts_at is null or p_ends_at is null
     or not private.on_half_hour(p_starts_at) or not private.on_half_hour(p_ends_at) then
    raise exception 'Half-hour slots only';
  end if;
  if p_ends_at <= p_starts_at then raise exception 'Invalid time range'; end if;
  if p_starts_at < s.starts_at or p_ends_at > s.ends_at then raise exception 'Outside the shift'; end if;
  if not p_allow_past and p_starts_at <= now() then raise exception 'Shift already started'; end if;

  select * into v_old from assignments where shift_id = p_shift_id and user_id = p_user_id;
  if not p_allow_past and found and v_old.starts_at <= now() then raise exception 'Booking already started'; end if;

  if v_role = 'participant' then
    if private.uncovered_slots(p_shift_id, p_starts_at, p_ends_at) > 0 then
      raise exception 'Slot without supervisor';
    end if;
    if private.max_participants(p_shift_id, p_starts_at, p_ends_at, p_user_id) >= s.capacity then
      raise exception 'Shift full';
    end if;
  end if;

  if exists (select 1 from assignments a
             where a.user_id = p_user_id and a.shift_id <> p_shift_id
               and tstzrange(a.starts_at, a.ends_at) && tstzrange(p_starts_at, p_ends_at)) then
    raise exception 'Overlapping shift';
  end if;

  -- Change of an existing supervisor booking: checked by trigger check_supervision
  insert into assignments (shift_id, user_id, role, starts_at, ends_at)
  values (p_shift_id, p_user_id, v_role, p_starts_at, p_ends_at)
  on conflict (shift_id, user_id) do update
    set starts_at = excluded.starts_at, ends_at = excluded.ends_at, role = excluded.role;
end $$;

create or replace function private.book(p_shift_id bigint, p_user_id uuid, p_starts_at timestamptz, p_ends_at timestamptz)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform private.book_at(p_shift_id, p_user_id, p_starts_at, p_ends_at, false);
end $$;

-- ---------------------------------------------------------------------
-- 2. Approval of a request: also when its hours have started or ended
-- ---------------------------------------------------------------------
create or replace function public.approve_request(
  p_request_id  bigint,
  p_task_id     bigint      default null,
  p_starts_at   timestamptz default null,
  p_ends_at     timestamptz default null,
  p_capacity    integer     default null,
  p_location    text        default null,
  p_description text        default null,
  p_note        text        default null,
  p_supervisor  uuid        default null
) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  r          shift_requests%rowtype;
  v_task_id  bigint;
  v_shift_id bigint;
  v_start    timestamptz;
  v_end      timestamptz;
begin
  if not public.is_admin() then raise exception 'Not authorized'; end if;

  select * into r from shift_requests where id = p_request_id for update;
  if not found then raise exception 'Request not found'; end if;
  if r.status <> 'pending' then raise exception 'Request not pending'; end if;
  if not exists (select 1 from profiles where id = r.requested_by and status = 'active') then
    raise exception 'Requester account not active';
  end if;

  v_task_id := coalesce(p_task_id, r.task_id);
  if v_task_id is null then raise exception 'Task required'; end if;
  v_start := coalesce(p_starts_at, r.starts_at);
  v_end   := coalesce(p_ends_at, r.ends_at);

  insert into shifts (task_id, starts_at, ends_at, capacity, location, description)
  values (v_task_id, v_start, v_end, coalesce(p_capacity, 1),
          coalesce(p_location, r.location), coalesce(p_description, r.description))
  returning id into v_shift_id;

  -- Supervisor first (participants need a supervisor), then the requester;
  -- past hours allowed (approval forgotten)
  perform private.book_at(v_shift_id, coalesce(p_supervisor, auth.uid()), v_start, v_end, true);
  if not exists (select 1 from assignments where shift_id = v_shift_id and role = 'supervisor') then
    raise exception 'Supervisor shall be an active admin';
  end if;
  if not exists (select 1 from assignments where shift_id = v_shift_id and user_id = r.requested_by) then
    perform private.book_at(v_shift_id, r.requested_by, v_start, v_end, true);
  end if;

  update shift_requests
  set status = 'approved', shift_id = v_shift_id, admin_note = p_note,
      decided_by = auth.uid(), decided_at = now()
  where id = p_request_id;

  return v_shift_id;
end $$;

revoke all on function private.book_at(bigint, uuid, timestamptz, timestamptz, boolean) from public;

-- ---------------------------------------------------------------------
-- 3. "Add supervisor" (an admin books an admin, p_user_id given): also on
--    past hours, to record who supervised (e.g. to replace a supervisor:
--    add the right one, then remove the wrong one, which is already
--    possible on past shifts). Own bookings: future hours only, as before.
--    (Can be run alone if sections 1-2 were already applied.)
-- ---------------------------------------------------------------------
create or replace function public.book_shift(
  p_shift_id  bigint,
  p_starts_at timestamptz,
  p_ends_at   timestamptz,
  p_user_id   uuid default null
) returns void
language plpgsql security definer set search_path = public as $$
declare v_user uuid := coalesce(p_user_id, auth.uid());
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not public.is_active() then raise exception 'Account not active'; end if;
  if v_user <> auth.uid() then
    if not public.is_admin() then raise exception 'Not authorized'; end if;
    if not exists (select 1 from profiles where id = v_user and role = 'admin' and status = 'active') then
      raise exception 'Only admins can be added as supervisors';
    end if;
  end if;
  perform private.book_at(p_shift_id, v_user, p_starts_at, p_ends_at,
    p_user_id is not null and public.is_admin()
    and exists (select 1 from profiles where id = v_user and role = 'admin' and status = 'active'));
end $$;

commit;
