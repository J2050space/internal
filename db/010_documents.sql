-- =====================================================================
-- J2050 internal tools - migration 010
-- Scope: document register, review milestones, documents required per
-- milestone.
--   * milestones: project reviews (data package due date, review date,
--     date held). Edited by admins. They replace tasks.milestone_label.
--   * documents: one row per document, named according to the J2050
--     Documentation Manual: [SUBTEAM]_[TYPE]_[Title]_VXX
--     Single responsible (active teamleader or admin), other subteams and
--     people involved.
--   * document_versions: V00, V01, ... with their workflow
--       in_progress -> in_review -> approved -> sent -> esa_accepted
--                      (returned by an admin)        \-> esa_changes
--     The responsible changes the status; only admins approve. Admins can
--     do everything. "Old version" is derived (a newer version exists).
--   * document_requirements: document x milestone, required level (draft,
--     release, update, ad hoc), optional Gantt task producing it, version
--     that fulfils it (set when the version is sent to ESA).
--   * document_history: change log written by triggers.
--   * Department THM renamed THS (Thermostructure), task codes included.
--   * The first version of a document can have any number, to continue
--     the numbering of a document started on SharePoint.
-- The production database, created with the first version of this file
-- and of 011, is brought up to date by 012.
-- Prerequisite: migrations 001-009 applied.
-- Run once in Supabase > SQL Editor. Runs as one transaction.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 0. Department THM -> THS (code of the Documentation Manual).
--    Existing tasks keep their number: THM-03 -> THS-03.
--    Check constraints use private.departments() and are evaluated on the
--    updated rows only. Task triggers are off: the rename is not a change
--    of the task (code and department are otherwise immutable).
-- ---------------------------------------------------------------------
create or replace function private.departments() returns text[]
language sql immutable as $$
  select array['SYS', 'ELE', 'SFW', 'AOCS', 'THS', 'TTC', 'OUT', 'MGT'];
$$;

alter table public.tasks disable trigger user;
update public.tasks set department = 'THS' where department = 'THM';
update public.tasks set code = 'THS' || substr(code, 4) where code like 'THM-%';
update public.tasks set teams = array_replace(teams, 'THM', 'THS') where 'THM' = any (teams);
alter table public.tasks enable trigger user;

update public.task_history set task_code = 'THS' || substr(task_code, 4) where task_code like 'THM-%';
update public.team_leaders set team = 'THS' where team = 'THM';
update public.task_code_counters set department = 'THS' where department = 'THM';

-- ---------------------------------------------------------------------
-- 1. Codes of the documents
--    Subteams: site departments + RED (whole team / RedPill as a whole).
--    EXT is not used (external documents are not tracked).
--    Types: Documentation Manual V01 without TD and MET (named by date,
--    not versioned).
-- ---------------------------------------------------------------------
create function private.doc_subteams() returns text[]
language sql immutable as $$
  select private.departments() || array['RED'];
$$;

create function private.doc_types() returns text[]
language sql immutable as $$
  select array['REQ', 'DREP', 'DS', 'AREP', 'TPLN', 'TSTP', 'PROC', 'TREP', 'NCR', 'RFD', 'RFW',
               'VCD', 'MAN', 'LOG', 'PLAN', 'PUR', 'PRES', 'TEMP', 'CAD', 'ECAD'];
$$;

grant execute on function private.doc_subteams() to authenticated, service_role;
grant execute on function private.doc_types()    to authenticated, service_role;

-- Field-by-field difference of two rows: { field: [old, new] }
create function private.jsonb_diff(p_old jsonb, p_new jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_object_agg(k, jsonb_build_array(p_old -> k, p_new -> k)), '{}')
  from jsonb_object_keys(p_new) as k
  where p_new -> k is distinct from p_old -> k;
$$;

-- ---------------------------------------------------------------------
-- 2. Milestones (reviews)
-- ---------------------------------------------------------------------
create table public.milestones (
  id           bigint generated always as identity primary key,
  code         text not null unique check (code ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),
  name         text not null check (char_length(trim(name)) between 1 and 80),
  phase        text,
  sort_order   integer not null default 0,
  docs_due     date,                    -- data package due
  review_date  date,                    -- planned date of the review
  held_on      date,                    -- date the review was held
  note         text,
  check (docs_due is null or review_date is null or docs_due <= review_date)
);

alter table public.milestones enable row level security;
create policy read_milestones  on public.milestones for select to authenticated using (public.is_active());
create policy admin_milestones on public.milestones for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------
-- 3. Documents
-- ---------------------------------------------------------------------
create table public.documents (
  id              bigint generated always as identity primary key,
  subteam         text not null check (subteam = any (private.doc_subteams())),
  doc_type        text not null check (doc_type = any (private.doc_types())),
  title           text not null check (title ~ '^[A-Z][A-Za-z0-9]*$' and char_length(title) <= 60),
  name            text not null check (char_length(trim(name)) between 1 and 120),
  esa_code        text,                 -- ESA reference of the deliverable (e.g. TS-VCD)
  subteams        text[] not null default '{}' check (subteams <@ private.doc_subteams()),
  responsible_id  uuid references public.profiles(id) on delete set null,
  people          text,
  priority        text check (priority in ('low', 'medium', 'high')),
  on_hold         boolean not null default false,
  on_hold_reason  text,
  folder_url      text,
  note            text,
  created_by      uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  updated_by      uuid references public.profiles(id) on delete set null,
  unique (subteam, doc_type, title),
  check (not on_hold or nullif(trim(on_hold_reason), '') is not null)
);

create table public.document_versions (
  id            bigint generated always as identity primary key,
  document_id   bigint not null references public.documents(id) on delete cascade,
  version       smallint not null check (version between 0 and 99),
  status        text not null default 'in_progress'
                check (status in ('in_progress', 'in_review', 'approved', 'sent', 'esa_accepted', 'esa_changes')),
  file_url      text,
  change_note   text,                   -- what changes in this version
  review_note   text,                   -- note of the admin when the version is returned
  submitted_at  timestamptz,
  submitted_by  uuid references public.profiles(id) on delete set null,
  approved_at   timestamptz,
  approved_by   uuid references public.profiles(id) on delete set null,
  sent_on       date,
  sent_by       uuid references public.profiles(id) on delete set null,
  esa_url       text,                   -- copy on the ESA SharePoint
  esa_comments  text,
  esa_outcome_at timestamptz,
  created_at    timestamptz not null default now(),
  created_by    uuid references public.profiles(id) on delete set null default auth.uid(),
  unique (document_id, version),
  check (status not in ('sent', 'esa_accepted', 'esa_changes')
         or (sent_on is not null and nullif(trim(esa_url), '') is not null)),
  check (status <> 'esa_changes' or nullif(trim(esa_comments), '') is not null)
);
create index document_versions_doc_idx on public.document_versions (document_id, version desc);

create table public.document_requirements (
  id            bigint generated always as identity primary key,
  milestone_id  bigint not null references public.milestones(id) on delete cascade,
  document_id   bigint not null references public.documents(id) on delete cascade,
  level         text not null check (level in ('draft', 'release', 'update', 'ad_hoc')),
  task_id       bigint references public.tasks(id) on delete set null,
  version_id    bigint references public.document_versions(id) on delete set null,
  waived        boolean not null default false,
  waived_reason text,
  note          text,
  unique (milestone_id, document_id),
  check (not waived or nullif(trim(waived_reason), '') is not null)
);
create index document_requirements_doc_idx on public.document_requirements (document_id);

alter table public.documents             enable row level security;
alter table public.document_versions     enable row level security;
alter table public.document_requirements enable row level security;

create policy read_documents on public.documents for select to authenticated using (public.is_active());
create policy read_doc_versions on public.document_versions for select to authenticated using (public.is_active());
create policy read_doc_requirements on public.document_requirements for select to authenticated using (public.is_active());

-- Documents and versions are written only through the functions below;
-- admins may delete a document directly. Requirements: admins.
create policy admin_delete_documents on public.documents for delete to authenticated using (public.is_admin());
create policy admin_doc_requirements on public.document_requirements for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------
-- 4. Consistency triggers
-- ---------------------------------------------------------------------
create function public.check_document_responsible() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.responsible_id is not null and not public.is_valid_leader(new.responsible_id) then
    raise exception 'Responsible shall be an active teamleader or admin';
  end if;
  return new;
end $$;

create trigger documents_responsible_check before insert or update of responsible_id on public.documents
  for each row execute function public.check_document_responsible();

-- Last change; the file name cannot change after the first approved version
create function public.touch_document() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    if (new.subteam, new.doc_type, new.title) is distinct from (old.subteam, old.doc_type, old.title)
       and exists (select 1 from document_versions v
                   where v.document_id = new.id and v.status <> 'in_progress' and v.status <> 'in_review') then
      raise exception 'File name cannot be changed after a release';
    end if;
    if (to_jsonb(new) - 'updated_at' - 'updated_by') is not distinct from (to_jsonb(old) - 'updated_at' - 'updated_by') then
      new.updated_at := old.updated_at;
      new.updated_by := old.updated_by;
      return new;
    end if;
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

create trigger documents_touch before insert or update on public.documents
  for each row execute function public.touch_document();

-- A requirement is fulfilled by a version of the same document, sent to ESA
create function public.check_requirement() returns trigger
language plpgsql security definer set search_path = public as $$
declare v document_versions%rowtype;
begin
  if new.version_id is not null then
    select * into v from document_versions where id = new.version_id;
    if v.document_id <> new.document_id then raise exception 'Version of another document'; end if;
    if v.status not in ('sent', 'esa_accepted', 'esa_changes') then
      raise exception 'Version not sent to ESA';
    end if;
  end if;
  return new;
end $$;

create trigger document_requirements_check before insert or update on public.document_requirements
  for each row execute function public.check_requirement();

-- ---------------------------------------------------------------------
-- 5. Change history
-- ---------------------------------------------------------------------
create table public.document_history (
  id           bigint generated always as identity primary key,
  document_id  bigint not null,         -- no foreign key: the history survives the document
  file_name    text,                    -- [SUBTEAM]_[TYPE]_[Title] at the time of the change
  version      smallint,
  action       text not null,
  changes      jsonb,
  changed_by   uuid references public.profiles(id) on delete set null,
  changed_at   timestamptz not null default now()
);
create index document_history_doc_idx on public.document_history (document_id, changed_at desc);

alter table public.document_history enable row level security;
create policy read_document_history on public.document_history for select to authenticated
  using (public.is_active());

create function private.doc_file_name(p_document_id bigint) returns text
language sql stable security definer set search_path = public as $$
  select subteam || '_' || doc_type || '_' || title from documents where id = p_document_id;
$$;

create function public.log_document_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_skip  text[] := array['updated_at', 'updated_by', 'created_at', 'created_by', 'id'];
  v_old   jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_new   jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_row   jsonb := coalesce(v_new, v_old);
  v_doc   bigint;
  v_name  text;
  v_ver   smallint;
  v_diff  jsonb;
  k       text;
begin
  foreach k in array v_skip loop
    v_old := v_old - k;
    v_new := v_new - k;
  end loop;

  if tg_table_name = 'documents' then
    v_doc  := (v_row ->> 'id')::bigint;
    v_name := (v_row ->> 'subteam') || '_' || (v_row ->> 'doc_type') || '_' || (v_row ->> 'title');
  else
    v_doc  := (v_row ->> 'document_id')::bigint;
    v_name := private.doc_file_name(v_doc);
    if v_name is null then return null; end if;   -- removed together with the document
  end if;

  if tg_table_name = 'document_versions' then
    v_ver := (v_row ->> 'version')::smallint;
  end if;
  if tg_table_name = 'document_requirements' then
    v_new := v_new || jsonb_build_object('milestone', (select code from milestones where id = (v_row ->> 'milestone_id')::bigint));
    v_old := v_old || jsonb_build_object('milestone', (select code from milestones where id = (v_row ->> 'milestone_id')::bigint));
  end if;

  if tg_op = 'UPDATE' then
    v_diff := private.jsonb_diff(v_old, v_new);
    if v_diff = '{}' then return null; end if;
  end if;

  insert into document_history (document_id, file_name, version, action, changes, changed_by)
  values (v_doc, v_name, v_ver,
          case tg_table_name
            when 'documents'         then 'document '
            when 'document_versions' then 'version '
            else 'requirement '
          end || case tg_op when 'INSERT' then 'created' when 'UPDATE' then 'updated' else 'deleted' end,
          case tg_op when 'INSERT' then v_new when 'UPDATE' then v_diff else v_old end,
          auth.uid());
  return null;
end $$;

create trigger documents_history after insert or update or delete on public.documents
  for each row execute function public.log_document_change();
create trigger document_versions_history after insert or update or delete on public.document_versions
  for each row execute function public.log_document_change();
create trigger document_requirements_history after insert or update or delete on public.document_requirements
  for each row execute function public.log_document_change();

-- ---------------------------------------------------------------------
-- 6. Functions used by the site
-- ---------------------------------------------------------------------
-- Admin, or responsible of the document
create function private.can_edit_document(p_document_id bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin()
      or (public.is_active() and exists (select 1 from documents
                                         where id = p_document_id and responsible_id = auth.uid()));
$$;

-- Save a document (new or existing).
--   p_fields: subteam, doc_type, title, name, esa_code, subteams, responsible_id,
--             people, priority, on_hold, on_hold_reason, folder_url, note
--   New documents: admins and teamleaders; a teamleader becomes the
--   responsible. Existing documents: admins and the responsible; only
--   admins change the responsible.
create function public.doc_save(p_id bigint, p_fields jsonb, p_expected timestamptz default null)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_id       bigint := p_id;
  v_role     text;
  v_admin    boolean := public.is_admin();
  v_current  timestamptz;
  v_resp     uuid := nullif(p_fields ->> 'responsible_id', '')::uuid;
  v_hold     boolean := coalesce((p_fields ->> 'on_hold')::boolean, false);
  v_subteams text[] := coalesce(array(select jsonb_array_elements_text(p_fields -> 'subteams')), '{}');
begin
  if not public.is_active() then raise exception 'Account not active'; end if;
  select role into v_role from profiles where id = auth.uid();

  if v_id is null then
    if not v_admin and v_role <> 'teamleader' then raise exception 'Not authorized'; end if;
    if not v_admin then v_resp := auth.uid(); end if;
    insert into documents (subteam, doc_type, title, name, esa_code, subteams, responsible_id, people,
                           priority, on_hold, on_hold_reason, folder_url, note)
    values (p_fields ->> 'subteam', p_fields ->> 'doc_type', trim(p_fields ->> 'title'),
            trim(p_fields ->> 'name'), nullif(trim(p_fields ->> 'esa_code'), ''), v_subteams, v_resp,
            nullif(trim(p_fields ->> 'people'), ''), nullif(p_fields ->> 'priority', ''),
            v_hold, case when v_hold then nullif(trim(p_fields ->> 'on_hold_reason'), '') end,
            nullif(trim(p_fields ->> 'folder_url'), ''), nullif(trim(p_fields ->> 'note'), ''))
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
    responsible_id = case when v_admin then v_resp else responsible_id end,
    people         = nullif(trim(p_fields ->> 'people'), ''),
    priority       = nullif(p_fields ->> 'priority', ''),
    on_hold        = v_hold,
    on_hold_reason = case when v_hold then nullif(trim(p_fields ->> 'on_hold_reason'), '') end,
    folder_url     = nullif(trim(p_fields ->> 'folder_url'), ''),
    note           = nullif(trim(p_fields ->> 'note'), '')
  where id = v_id;
  return v_id;
end $$;

-- Start the next version. p_version: number of the first version only
-- (default V00; a document started on SharePoint continues its
-- numbering); later versions are numbered last + 1. The previous
-- version shall have left the internal review.
create function public.doc_new_version(
  p_document_id bigint,
  p_file_url    text    default null,
  p_change_note text    default null,
  p_version     integer default null
) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_last document_versions%rowtype;
  v_next integer;
  v_id   bigint;
begin
  if not private.can_edit_document(p_document_id) then raise exception 'Not authorized'; end if;
  perform 1 from documents where id = p_document_id for update;
  if not found then raise exception 'Document not found'; end if;
  select * into v_last from document_versions where document_id = p_document_id order by version desc limit 1;
  if found then
    if p_version is not null and p_version <> v_last.version + 1 then
      raise exception 'Version number can be chosen only for the first version';
    end if;
    if v_last.status in ('in_progress', 'in_review') then raise exception 'Previous version not released'; end if;
    if v_last.version >= 99 then raise exception 'Version limit reached'; end if;
    v_next := v_last.version + 1;
  else
    v_next := coalesce(p_version, 0);
    if v_next < 0 or v_next > 99 then raise exception 'Version number out of range'; end if;
  end if;
  insert into document_versions (document_id, version, file_url, change_note)
  values (p_document_id, v_next, nullif(trim(p_file_url), ''), nullif(trim(p_change_note), ''))
  returning id into v_id;
  return v_id;
end $$;

-- Actions on a version.
--   edit        file_url, change_note (in progress); esa_url, esa_comments (after sending)
--   submit      in_progress -> in_review                 responsible, admin
--   withdraw    in_review   -> in_progress               responsible, admin
--   approve     in_review   -> approved                  admin
--   return      in_review   -> in_progress, review_note  admin
--   send        approved    -> sent; sent_on, esa_url, requirements (ids
--               of requirements of this document fulfilled by the version)
--   esa_accept  sent, esa_changes -> esa_accepted
--   esa_changes sent, esa_accepted -> esa_changes; esa_comments
--   reset       any -> in_progress (admin; requirements lose this version)
--   delete      version in progress (responsible) or any (admin)
create function public.doc_version_action(p_version_id bigint, p_action text, p_fields jsonb default '{}')
returns void
language plpgsql security definer set search_path = public as $$
declare
  v       document_versions%rowtype;
  v_admin boolean := public.is_admin();
  v_today date := (now() at time zone 'Europe/Rome')::date;
  v_sent  date;
  v_reqs  bigint[];
begin
  select * into v from document_versions where id = p_version_id for update;
  if not found then raise exception 'Version not found'; end if;
  if not private.can_edit_document(v.document_id) then raise exception 'Not authorized'; end if;

  case p_action
  when 'edit' then
    if v.status in ('in_progress', 'in_review') or v_admin then
      update document_versions set
        file_url    = coalesce(nullif(trim(p_fields ->> 'file_url'), ''), case when p_fields ? 'file_url' then null else file_url end),
        change_note = case when p_fields ? 'change_note' then nullif(trim(p_fields ->> 'change_note'), '') else change_note end
      where id = v.id;
    end if;
    if v.status in ('sent', 'esa_accepted', 'esa_changes') then
      update document_versions set
        esa_url      = case when p_fields ? 'esa_url' then nullif(trim(p_fields ->> 'esa_url'), '') else esa_url end,
        esa_comments = case when p_fields ? 'esa_comments' then nullif(trim(p_fields ->> 'esa_comments'), '') else esa_comments end
      where id = v.id;
    elsif not (v.status in ('in_progress', 'in_review') or v_admin) then
      raise exception 'Released version cannot be changed';
    end if;

  when 'submit' then
    if v.status <> 'in_progress' then raise exception 'Version not in progress'; end if;
    if nullif(trim(coalesce(p_fields ->> 'file_url', v.file_url)), '') is null then raise exception 'File link required'; end if;
    update document_versions set status = 'in_review', review_note = null,
      file_url = coalesce(nullif(trim(p_fields ->> 'file_url'), ''), file_url),
      submitted_at = now(), submitted_by = auth.uid()
    where id = v.id;

  when 'withdraw' then
    if v.status <> 'in_review' then raise exception 'Version not in review'; end if;
    update document_versions set status = 'in_progress' where id = v.id;

  when 'approve' then
    if not v_admin then raise exception 'Not authorized'; end if;
    if v.status <> 'in_review' then raise exception 'Version not in review'; end if;
    update document_versions set status = 'approved', approved_at = now(), approved_by = auth.uid()
    where id = v.id;

  when 'return' then
    if not v_admin then raise exception 'Not authorized'; end if;
    if v.status <> 'in_review' then raise exception 'Version not in review'; end if;
    if nullif(trim(p_fields ->> 'review_note'), '') is null then raise exception 'Note required'; end if;
    update document_versions set status = 'in_progress', review_note = trim(p_fields ->> 'review_note')
    where id = v.id;

  when 'send' then
    if v.status <> 'approved' then raise exception 'Version not approved'; end if;
    v_sent := coalesce(nullif(p_fields ->> 'sent_on', '')::date, v_today);
    if v_sent > v_today then raise exception 'Actual dates cannot be in the future'; end if;
    if nullif(trim(p_fields ->> 'esa_url'), '') is null then raise exception 'ESA link required'; end if;
    update document_versions set status = 'sent', sent_on = v_sent, sent_by = auth.uid(),
      esa_url = trim(p_fields ->> 'esa_url')
    where id = v.id;
    v_reqs := coalesce(array(select jsonb_array_elements_text(p_fields -> 'requirements')::bigint), '{}');
    if exists (select 1 from unnest(v_reqs) r
               where not exists (select 1 from document_requirements q
                                 where q.id = r and q.document_id = v.document_id)) then
      raise exception 'Requirement of another document';
    end if;
    update document_requirements set version_id = v.id where id = any (v_reqs);

  when 'esa_accept' then
    if v.status not in ('sent', 'esa_changes') then raise exception 'Version not sent to ESA'; end if;
    update document_versions set status = 'esa_accepted', esa_outcome_at = now() where id = v.id;

  when 'esa_changes' then
    if v.status not in ('sent', 'esa_accepted') then raise exception 'Version not sent to ESA'; end if;
    if nullif(trim(coalesce(p_fields ->> 'esa_comments', v.esa_comments)), '') is null then
      raise exception 'ESA comments required';
    end if;
    update document_versions set status = 'esa_changes', esa_outcome_at = now(),
      esa_comments = coalesce(nullif(trim(p_fields ->> 'esa_comments'), ''), esa_comments)
    where id = v.id;

  when 'reset' then
    if not v_admin then raise exception 'Not authorized'; end if;
    update document_requirements set version_id = null where version_id = v.id;
    update document_versions set status = 'in_progress', approved_at = null, approved_by = null,
      sent_on = null, sent_by = null, esa_outcome_at = null
    where id = v.id;

  when 'delete' then
    if not v_admin and v.status <> 'in_progress' then raise exception 'Only versions in progress can be deleted'; end if;
    if exists (select 1 from document_versions where document_id = v.document_id and version > v.version) then
      raise exception 'Only the last version can be deleted';
    end if;
    delete from document_versions where id = v.id;

  else
    raise exception 'Unknown action';
  end case;
end $$;

-- ---------------------------------------------------------------------
-- 7. Gantt: milestones replace the free milestone label of the tasks
--    (no task had a label when this migration was written)
-- ---------------------------------------------------------------------
create or replace function public.admin_save_task(
  p_id          bigint,
  p_fields      jsonb,
  p_depends_on  bigint[]    default null,
  p_required_by bigint[]    default null,
  p_expected    timestamptz default null
) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_id        bigint := p_id;
  v_current   timestamptz;
  v_children  boolean;
  v_today     date := (now() at time zone 'Europe/Rome')::date;
  v_started   date := nullif(p_fields ->> 'started_on', '')::date;
  v_completed date := nullif(p_fields ->> 'completed_on', '')::date;
  v_blocked   boolean := coalesce((p_fields ->> 'blocked')::boolean, false);
  v_teams     text[];
begin
  if not public.is_admin() then raise exception 'Not authorized'; end if;
  if v_started > v_today or v_completed > v_today then raise exception 'Actual dates cannot be in the future'; end if;
  v_teams := coalesce(array(select jsonb_array_elements_text(p_fields -> 'teams')), '{}');

  if v_id is null then
    insert into tasks (code, department, name, parent_id, start_date, end_date, deadline,
                       started_on, completed_on, blocked, blocked_reason,
                       leader_id, people, note, teams)
    values ('-', nullif(p_fields ->> 'department', ''), trim(p_fields ->> 'name'),
            nullif(p_fields ->> 'parent_id', '')::bigint,
            (p_fields ->> 'start_date')::date, (p_fields ->> 'end_date')::date,
            nullif(p_fields ->> 'deadline', '')::date,
            v_started, v_completed, v_blocked,
            case when v_blocked then nullif(trim(p_fields ->> 'blocked_reason'), '') end,
            nullif(p_fields ->> 'leader_id', '')::uuid,
            nullif(trim(p_fields ->> 'people'), ''),
            nullif(trim(p_fields ->> 'note'), ''),
            v_teams)
    returning id into v_id;
  else
    select updated_at into v_current from tasks where id = v_id for update;
    if not found then raise exception 'Task not found'; end if;
    if p_expected is not null and v_current <> p_expected then
      raise exception 'Task modified by someone else';
    end if;
    v_children := exists (select 1 from tasks where parent_id = v_id);
    update tasks set
      department      = coalesce(nullif(p_fields ->> 'department', ''), department),
      name            = trim(p_fields ->> 'name'),
      start_date      = case when v_children then start_date   else (p_fields ->> 'start_date')::date end,
      end_date        = case when v_children then end_date     else (p_fields ->> 'end_date')::date end,
      started_on      = case when v_children then started_on   else v_started end,
      completed_on    = case when v_children then completed_on else v_completed end,
      blocked         = case when v_children then false else v_blocked end,
      blocked_reason  = case when v_children or not v_blocked then null
                             else nullif(trim(p_fields ->> 'blocked_reason'), '') end,
      deadline        = nullif(p_fields ->> 'deadline', '')::date,
      leader_id       = nullif(p_fields ->> 'leader_id', '')::uuid,
      people          = nullif(trim(p_fields ->> 'people'), ''),
      note            = nullif(trim(p_fields ->> 'note'), ''),
      teams           = v_teams
    where id = v_id;
  end if;

  if p_depends_on is not null then
    delete from task_dependencies where task_id = v_id and depends_on <> all (p_depends_on);
    insert into task_dependencies (task_id, depends_on)
    select v_id, d from unnest(p_depends_on) as d on conflict do nothing;
  end if;
  if p_required_by is not null then
    delete from task_dependencies where depends_on = v_id and task_id <> all (p_required_by);
    insert into task_dependencies (task_id, depends_on)
    select r, v_id from unnest(p_required_by) as r on conflict do nothing;
  end if;
  return v_id;
end $$;

alter table public.tasks drop column milestone_label;

-- ---------------------------------------------------------------------
-- 8. Privileges
-- ---------------------------------------------------------------------
grant select on public.milestones, public.documents, public.document_versions,
                public.document_requirements, public.document_history to authenticated, service_role;
grant insert, update, delete on public.milestones, public.document_requirements to authenticated;
grant delete on public.documents to authenticated;
grant usage on all sequences in schema public to authenticated;

revoke all on function private.jsonb_diff(jsonb, jsonb)       from public;
revoke all on function private.doc_file_name(bigint)          from public;
revoke all on function private.can_edit_document(bigint)      from public;

revoke execute on function public.doc_save(bigint, jsonb, timestamptz)       from public, anon;
grant  execute on function public.doc_save(bigint, jsonb, timestamptz)       to authenticated;
revoke execute on function public.doc_new_version(bigint, text, text, integer) from public, anon;
grant  execute on function public.doc_new_version(bigint, text, text, integer) to authenticated;
revoke execute on function public.doc_version_action(bigint, text, jsonb)    from public, anon;
grant  execute on function public.doc_version_action(bigint, text, jsonb)    to authenticated;

revoke execute on function public.check_document_responsible() from public, anon, authenticated;
revoke execute on function public.touch_document()             from public, anon, authenticated;
revoke execute on function public.check_requirement()          from public, anon, authenticated;
revoke execute on function public.log_document_change()        from public, anon, authenticated;

commit;
