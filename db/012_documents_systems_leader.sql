-- =====================================================================
-- J2050 internal tools - migration 012
-- Scope: rights of the Systems leader on documents and milestones.
--   * Document managers: admins and the leader of the SYS sub-team
--     (team_leaders, set by the admins; active teamleader or admin).
--     The rights follow the assignment: a new SYS leader gets them, the
--     former one loses them.
--   * Document managers create, edit and delete every document, move its
--     versions, change the responsible, edit milestones and required
--     documents. Only admins approve, return and reset versions.
--   * The responsible of a document also edits its required documents.
-- Only for the production database: 010 already contains these changes
-- for a new database.
-- Prerequisite: migrations 001-011 applied.
-- Run once in Supabase > SQL Editor. Runs as one transaction.
-- =====================================================================
begin;

-- Admin, or leader of the SYS sub-team
create function private.is_doc_manager() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin()
      or exists (select 1 from team_leaders tl
                   join profiles p on p.id = tl.leader_id
                  where tl.team = 'SYS' and tl.leader_id = auth.uid()
                    and p.status = 'active' and p.role in ('teamleader', 'admin'));
$$;

-- Document manager, or responsible of the document
create or replace function private.can_edit_document(p_document_id bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select private.is_doc_manager()
      or (public.is_active() and exists (select 1 from documents
                                         where id = p_document_id and responsible_id = auth.uid()));
$$;

-- Policies (the functions are used by Row Level Security)
revoke all     on function private.is_doc_manager()          from public;
grant  execute on function private.is_doc_manager()          to authenticated;
grant  execute on function private.can_edit_document(bigint) to authenticated;

drop policy admin_milestones on public.milestones;
create policy manage_milestones on public.milestones for all to authenticated
  using (private.is_doc_manager()) with check (private.is_doc_manager());

drop policy admin_delete_documents on public.documents;
create policy manage_delete_documents on public.documents for delete to authenticated
  using (private.is_doc_manager());

drop policy admin_doc_requirements on public.document_requirements;
create policy edit_doc_requirements on public.document_requirements for all to authenticated
  using (private.can_edit_document(document_id)) with check (private.can_edit_document(document_id));

-- Save a document (new or existing).
--   p_fields: subteam, doc_type, title, name, esa_code, subteams, responsible_id,
--             people, priority, on_hold, on_hold_reason, folder_url, working_url, note
--   New documents: document managers and teamleaders; a teamleader becomes
--   the responsible. Existing documents: document managers and the
--   responsible; only document managers change the responsible.
create or replace function public.doc_save(p_id bigint, p_fields jsonb, p_expected timestamptz default null)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_id       bigint := p_id;
  v_role     text;
  v_manager  boolean := private.is_doc_manager();
  v_current  timestamptz;
  v_resp     uuid := nullif(p_fields ->> 'responsible_id', '')::uuid;
  v_hold     boolean := coalesce((p_fields ->> 'on_hold')::boolean, false);
  v_subteams text[] := coalesce(array(select jsonb_array_elements_text(p_fields -> 'subteams')), '{}');
begin
  if not public.is_active() then raise exception 'Account not active'; end if;
  select role into v_role from profiles where id = auth.uid();

  if v_id is null then
    if not v_manager and v_role <> 'teamleader' then raise exception 'Not authorized'; end if;
    if not v_manager then v_resp := auth.uid(); end if;
    insert into documents (subteam, doc_type, title, name, esa_code, subteams, responsible_id, people,
                           priority, on_hold, on_hold_reason, folder_url, working_url, note)
    values (p_fields ->> 'subteam', p_fields ->> 'doc_type', trim(p_fields ->> 'title'),
            trim(p_fields ->> 'name'), nullif(trim(p_fields ->> 'esa_code'), ''), v_subteams, v_resp,
            nullif(trim(p_fields ->> 'people'), ''), nullif(p_fields ->> 'priority', ''),
            v_hold, case when v_hold then nullif(trim(p_fields ->> 'on_hold_reason'), '') end,
            nullif(trim(p_fields ->> 'folder_url'), ''), nullif(trim(p_fields ->> 'working_url'), ''),
            nullif(trim(p_fields ->> 'note'), ''))
    returning id into v_id;
    return v_id;
  end if;

  if not private.can_edit_document(v_id) then raise exception 'Not authorized'; end if;
  select updated_at into v_current from documents where id = v_id for update;
  if not found then raise exception 'Document not found'; end if;
  if p_expected is not null and v_current <> p_expected then
    raise exception 'Document modified by someone else';
  end if;

  update documents set
    subteam        = p_fields ->> 'subteam',
    doc_type       = p_fields ->> 'doc_type',
    title          = trim(p_fields ->> 'title'),
    name           = trim(p_fields ->> 'name'),
    esa_code       = nullif(trim(p_fields ->> 'esa_code'), ''),
    subteams       = v_subteams,
    responsible_id = case when v_manager then v_resp else responsible_id end,
    people         = nullif(trim(p_fields ->> 'people'), ''),
    priority       = nullif(p_fields ->> 'priority', ''),
    on_hold        = v_hold,
    on_hold_reason = case when v_hold then nullif(trim(p_fields ->> 'on_hold_reason'), '') end,
    folder_url     = nullif(trim(p_fields ->> 'folder_url'), ''),
    working_url    = nullif(trim(p_fields ->> 'working_url'), ''),
    note           = nullif(trim(p_fields ->> 'note'), '')
  where id = v_id;
  return v_id;
end $$;

commit;
