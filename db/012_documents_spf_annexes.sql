-- =====================================================================
-- J2050 internal tools - migration 012
-- ONLY FOR THE PRODUCTION DATABASE (created with 010, 011 and the former
-- 012-013). A new database needs only 010 and 011, which already contain
-- all of this.
--   * Documents: link to the working file (Word, Excel...), one for all
--     versions. The link of a version is its PDF.
--   * An approved version is frozen, also for admins (PDF and notes);
--     only ESA link and comments are added after sending. Only a version
--     in progress can be deleted (an admin resets it first if needed).
--   * Documents from the FYS DRD Satellite Project File and the FYS4
--     Environmental Testing DRDs: SPF annexes required at the KOR, AOCS
--     analysis, schedule, CAD, risk register, thermal correlation report;
--     ESA codes MAR, FMEA-RPT, LINK-ARPT, VIBE-TRPT.
-- Existing documents and requirements are not touched, except name, ESA
-- code and note of SYS_AREP_FailureModesEffects, SYS_AREP_MissionAnalysis,
-- TTC_AREP_LinkDataBudget, SYS_TREP_VibrationTest.
-- Can be run again: the result does not change.
-- Run in Supabase > SQL Editor. Runs as one transaction.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. Working file and frozen approved versions (as in 010)
-- ---------------------------------------------------------------------
alter table public.documents add column if not exists working_url text;

-- Save a document (new or existing).
--   p_fields: subteam, doc_type, title, name, esa_code, subteams, responsible_id,
--             people, priority, on_hold, on_hold_reason, folder_url, working_url, note
--   New documents: admins and teamleaders; a teamleader becomes the
--   responsible. Existing documents: admins and the responsible; only
--   admins change the responsible.
create or replace function public.doc_save(p_id bigint, p_fields jsonb, p_expected timestamptz default null)
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
    responsible_id = case when v_admin then v_resp else responsible_id end,
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

-- Actions on a version.
--   edit        file_url (PDF), change_note (in progress, in review);
--               esa_url, esa_comments (after sending). An approved version is
--               frozen, also for admins: changes go in the next version.
--   submit      in_progress -> in_review                 responsible, admin
--   withdraw    in_review   -> in_progress               responsible, admin
--   approve     in_review   -> approved                  admin
--   return      in_review   -> in_progress, review_note  admin
--   send        approved    -> sent; sent_on, esa_url, requirements (ids
--               of requirements of this document fulfilled by the version)
--   esa_accept  sent, esa_changes -> esa_accepted
--   esa_changes sent, esa_accepted -> esa_changes; esa_comments
--   reset       any -> in_progress (admin; requirements lose this version)
--   delete      last version, in progress (an admin resets it first if needed)
create or replace function public.doc_version_action(p_version_id bigint, p_action text, p_fields jsonb default '{}')
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
    if v.status in ('in_progress', 'in_review') then
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
    elsif v.status = 'approved' then
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
    if v.status <> 'in_progress' then raise exception 'Only versions in progress can be deleted'; end if;
    if exists (select 1 from document_versions where document_id = v.document_id and version > v.version) then
      raise exception 'Only the last version can be deleted';
    end if;
    delete from document_versions where id = v.id;

  else
    raise exception 'Unknown action';
  end case;
end $$;

-- ---------------------------------------------------------------------
-- 2. Documents
-- ---------------------------------------------------------------------
insert into public.documents (subteam, doc_type, title, name, esa_code, subteams, note) values
  ('AOCS', 'AREP', 'AOCSAnalysis', 'AOCS Analysis Report', 'AOCS-ARPT', '{}', null),
  ('MGT', 'PLAN', 'Schedule', 'Project Schedule', null, '{}', 'Export of the Gantt of this site: milestones, deliveries, holidays and exam periods.'),
  ('THS', 'CAD', 'Satellite', 'Satellite CAD Model', 'CAD', '{SYS}', 'STEP format preferred.'),
  ('MGT', 'AREP', 'RiskRegister', 'Project Risk Register', 'RR', '{SYS}', 'Format tailored from ECSS-M-ST-80C (SPF DRD section 20).'),
  ('THS', 'AREP', 'ThermalCorrelation', 'Thermal Analysis Correlation Report', null, '{}', 'Only if the TVAC test includes thermal balance phases.')
on conflict (subteam, doc_type, title) do nothing;

update public.documents d set name = u.name, esa_code = u.esa_code, note = u.note
from (values
  ('SYS_AREP_FailureModesEffects', 'FMEA Report (FMEA, HSIA, FDIR)', 'FMEA-RPT', 'Criticality analysis not requested in FYS. Basis of the FDIR verification in the functional and mission tests.'),
  ('SYS_AREP_MissionAnalysis', 'Mission Analysis Report', 'MAR', null),
  ('TTC_AREP_LinkDataBudget', 'Link and Data Budget Analysis Report', 'LINK-ARPT', null),
  ('SYS_TREP_VibrationTest', 'FM Vibration Test Report', 'VIBE-TRPT', null)
) as u(file, name, esa_code, note)
where d.subteam || '_' || d.doc_type || '_' || d.title = u.file;

-- ---------------------------------------------------------------------
-- 3. Required level at each milestone (new ones only)
-- ---------------------------------------------------------------------
create temp table seed_requirements (file text, milestone text, level text, note text) on commit drop;

insert into seed_requirements values
  ('SYS_AREP_MissionAnalysis', 'KOR', 'update', 'Annex of the Satellite Project File.'),
  ('AOCS_AREP_AOCSAnalysis', 'KOR', 'update', 'Annex of the Satellite Project File.'),
  ('TTC_AREP_LinkDataBudget', 'KOR', 'update', 'Annex of the Satellite Project File.'),
  ('THS_AREP_StructuralAnalysis', 'KOR', 'update', 'Annex of the Satellite Project File.'),
  ('THS_AREP_ThermalAnalysis', 'KOR', 'update', 'Annex of the Satellite Project File.'),
  ('SYS_AREP_SpaceDebrisMitigation', 'KOR', 'update', 'Annex of the Satellite Project File.'),
  ('SYS_DREP_DeclaredMaterials', 'KOR', 'update', 'Annex of the Satellite Project File.'),
  ('SYS_DREP_ProductTree', 'KOR', 'update', 'Annex of the Satellite Project File.'),
  ('SYS_VCD_TechnicalSpecification', 'KOR', 'update', 'Annex of the Satellite Project File.'),
  ('SYS_VCD_FYSDesignSpecification', 'KOR', 'update', 'Annex of the Satellite Project File.'),
  ('MGT_PLAN_Schedule', 'KOR', 'update', 'Annex of the Satellite Project File.'),
  ('THS_CAD_Satellite', 'KOR', 'update', 'Annex of the Satellite Project File.'),
  ('MGT_AREP_RiskRegister', 'KOR', 'update', 'Annex of the Satellite Project File.'),
  ('ELE_TREP_BatteryPackAcceptance', 'FAR', 'release', 'Annex IV of the Battery Report (TBC by ESA).'),
  ('THS_AREP_ThermalCorrelation', 'FAR', 'ad_hoc', 'Only with thermal balance phases in the TVAC test.');

insert into public.document_requirements (milestone_id, document_id, level, note)
select m.id, d.id, r.level, r.note
from seed_requirements r
join public.documents  d on d.subteam || '_' || d.doc_type || '_' || d.title = r.file
join public.milestones m on m.code = r.milestone
on conflict (milestone_id, document_id) do nothing;

commit;
