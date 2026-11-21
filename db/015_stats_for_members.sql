-- =====================================================================
-- J2050 internal tools - migration 015
-- Scope: the Stats page (booked hours of ended lab shifts, by person and
-- by task) is open to every active member, not only to the admins.
-- The bookings are already visible to everybody on the Lab shifts page:
-- the totals add no new personal data.
-- public.lab_hours (active members) has the same result columns as
-- public.admin_hours (admins only). admin_hours is kept, so that the
-- published site keeps working until the new pages are online; it can be
-- dropped later (drop function public.admin_hours(date, date);).
-- Only adds a function: the published site is not affected.
-- Prerequisite: migrations 001-014 applied.
-- Run in Supabase > SQL Editor. Runs as one transaction; it can be run
-- again (create or replace only).
-- Revert: drop function if exists public.lab_hours(date, date);
-- =====================================================================
begin;

create or replace function public.lab_hours(p_from date, p_to date)
returns table (user_id uuid, person text, task_id bigint, role text, hours numeric, shifts integer)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_active() then raise exception 'Account not active'; end if;
  return query
    select a.user_id,
           coalesce(p.full_name, p.email),
           s.task_id,
           a.role,
           round(sum(extract(epoch from (a.ends_at - a.starts_at)) / 3600.0)::numeric, 2),
           count(*)::integer
    from public.assignments a
    join public.shifts s   on s.id = a.shift_id
    join public.profiles p on p.id = a.user_id
    where a.ends_at <= now()
      and a.starts_at >= (p_from::timestamp at time zone 'Europe/Rome')
      and a.starts_at <  ((p_to + 1)::timestamp at time zone 'Europe/Rome')
    group by a.user_id, p.full_name, p.email, s.task_id, a.role;
end $$;

revoke execute on function public.lab_hours(date, date) from public, anon;
grant  execute on function public.lab_hours(date, date) to authenticated;

commit;
