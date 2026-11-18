-- =====================================================================
-- J2050 internal tools - migration 013
-- Scope: the first version of a document registered on the site can have
-- any number (V00-V99), so that documents started on SharePoint continue
-- their numbering (e.g. V03 there, next version V04 here). The following
-- versions are numbered last + 1 as before.
-- Prerequisite: migration 010 applied.
-- Run once in Supabase > SQL Editor. Runs as one transaction.
-- =====================================================================
begin;

drop function public.doc_new_version(bigint, text, text);

-- Start the next version. p_version: number of the first version only
-- (default V00); later versions are numbered last + 1. The previous
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

revoke execute on function public.doc_new_version(bigint, text, text, integer) from public, anon;
grant  execute on function public.doc_new_version(bigint, text, text, integer) to authenticated;

commit;
