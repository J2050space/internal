-- =====================================================================
-- J2050 internal tools - migration 012
-- ONLY FOR THE PRODUCTION DATABASE, where the first versions of 010 and
-- 011 (draft timeline) were applied. A new database needs only 010 and
-- 011. It brings the production database to the current 010 and 011:
--   * doc_new_version: number of the first version can be chosen.
--   * Old milestones (PDR, CDR, TRR-TRB, AR, FRR) are deleted with their
--     requirements.
--   * Documents of the first 011 no longer in the list are deleted unless
--     they already have versions (kept, with a notice).
--   * Milestones, documents and requirements are inserted or updated.
--     Existing documents keep id, versions and responsible; name, ESA
--     code and note are updated; involved subteams only if empty.
-- Sources: milestone and deliverables summaries of the FYS4 training week
-- (Phase D1 and D2) and FYS4 Phase D DRDs and Guidelines v1.0; documents
-- of the former SharePoint document tracker (titles only, no status).
-- RedPill is treated as a PocketQube (FYS Design Specification for
-- PocketQubes): the EQSL is listed but not required at a milestone.
-- Requirements marked "assumption" in their note are not in the ESA
-- lists. Documents without requirement are assigned from the site.
-- NCR, RFD and RFW are created when needed: no fixed document.
-- Can be run again: it restores the seeded data (milestone names and
-- notes, document names, levels and notes of the seeded requirements);
-- dates, responsibles, versions and links to tasks are kept.
-- Prerequisite: migrations 010 and 011 (first versions) applied.
-- Run in Supabase > SQL Editor. Runs as one transaction.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 0. Versions: number of the first version can be chosen (as in 010)
-- ---------------------------------------------------------------------
drop function if exists public.doc_new_version(bigint, text, text);

-- Start the next version. p_version: number of the first version only
-- (default V00); later versions are numbered last + 1. The previous
-- version shall have left the internal review.
create or replace function public.doc_new_version(
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

-- ---------------------------------------------------------------------
-- 1. Milestones
-- ---------------------------------------------------------------------
delete from public.milestones where code in ('PDR', 'CDR', 'TRR-TRB', 'AR', 'FRR');

insert into public.milestones (code, name, phase, sort_order, note) values
  ('KOR',      'Kick Off Review (D1.10)', 'D1', 10,
   'Soundness of the design and consolidated AIV plan. Satellite Project File before the review, then team presentation.'),
  ('IFV',      'Interfaces Verification (D1.20)', 'D1', 20,
   'University cleanroom, once the flight model is integrated: FDS interface requirements (mass, dimensions, layout), basic functions, deployer fit check if possible.'),
  ('FTC-KO',   'Functional Test Campaign Kick Off (D1.30)', 'D1', 30,
   'Online with ESA at least 2 weeks before the campaign: integration results, open RIDs, actions, NCRs and RFWs, test documents complete, configuration control, facilities and GSE.'),
  ('FFT-PRT',  'Full Functional Test, Post Test Review (D1.45)', 'D1', 40,
   'FFT Test Readiness Review (D1.40) at the university before the test.'),
  ('MT-TRR',   'Mission Test, Test Readiness Review (D1.50)', 'D1', 50,
   null),
  ('MT-PRT',   'Mission Test, Post Test Review (D1.55)', 'D1', 60,
   null),
  ('D1-CO',    'Phase D1 Close-out, Ticket to Test (D1.60 data package, D1.70 review)', 'D1', 70,
   'Satellite integrated and tested in laboratory conditions, NCRs processed, TS-VCD and FDS-VCD up to date, RFDs and RFWs processed, KOR and FTC items closed. NCR, RFD and RFW are delivered with the data package.'),
  ('ETC-KO',   'Environmental Test Campaign Kick Off (D2.10)', 'D2', 80,
   'Online with ESA: functional test results, open RIDs, NCRs and RFWs, final analyses, test levels and schedule, GSE, satellite ready for shipment. Consent to ship follows.'),
  ('VT-TRR',   'Vibration Test, Test Readiness Review (D2.20)', 'D2', 90,
   'At the ESA test facility. Post Test Review: D2.25.'),
  ('TVAC-TRR', 'Thermal Vacuum Test, Test Readiness Review (D2.30)', 'D2', 100,
   'At the ESA test facility. Post Test Review: D2.35.'),
  ('FAR',      'Flight Acceptance Review, Ticket to Orbit (D2.40 data package, D2.80 board)', 'D2', 110,
   'ESA review of the data package, RIDs and colocations (D2.50-D2.70), then FAR Board. NCRs closed or with a closure plan, RFDs and RFWs approved; NCR, RFD and RFW delivered with the data package.'),
  ('LAUNCH',   'Launch Campaign (Phase E1)', 'E1', 120,
   null),
  ('PFR',      'Post Flight Review (Phase E2)', 'E2', 130,
   null)
on conflict (code) do update set
  name = excluded.name, phase = excluded.phase, sort_order = excluded.sort_order, note = excluded.note;

-- ---------------------------------------------------------------------
-- 2. Documents
-- ---------------------------------------------------------------------
do $$
declare
  v_old text[] := array[
    'SYS_DREP_MissionDescriptionOperations', 'SYS_DREP_DesignDefinitionJustification',
    'SYS_AREP_MissionOperationsResults', 'SYS_PLAN_AssemblyIntegrationVerification',
    'SYS_AREP_OrbitAnalysis', 'SYS_AREP_RadiationAnalysis',
    'SYS_DREP_FaultDetectionIsolationRecovery', 'MGT_PLAN_ProjectManagement',
    'RED_MAN_LessonsLearned'];
  v_kept text;
begin
  delete from public.documents d
  where d.subteam || '_' || d.doc_type || '_' || d.title = any (v_old)
    and not exists (select 1 from public.document_versions v where v.document_id = d.id);
  select string_agg(d.subteam || '_' || d.doc_type || '_' || d.title, ', ') into v_kept
  from public.documents d where d.subteam || '_' || d.doc_type || '_' || d.title = any (v_old);
  if v_kept is not null then
    raise notice 'Kept because they have versions (delete them from the site if not needed): %', v_kept;
  end if;
end $$;

insert into public.documents (subteam, doc_type, title, name, esa_code, subteams, note) values
  -- Kick Off Review
  ('SYS', 'DREP', 'SatelliteProjectFile',         'Satellite Project File',                                   'SPF',       '{}', 'Derived from the Satellite Proposal.'),
  ('SYS', 'AREP', 'FailureModesEffects',          'Failure Modes, Effects and Criticality Analysis, FDIR',    'FMECA',     '{}', 'Basis of the FDIR verification in the functional and mission tests.'),
  ('SYS', 'AREP', 'MissionAnalysis',              'Mission Analysis Report',                                  null,        '{}', null),
  -- Assembly, integration, interfaces verification
  ('RED', 'PROC', 'QMIntegration',                'QM Assembly and Integration Procedure',                    null,        '{}', null),
  ('RED', 'PROC', 'SatelliteIntegration',         'FM Assembly and Integration Procedure',                    'AI-PRO',    '{}', 'System level. The as-run version closes the integration.'),
  ('RED', 'LOG',  'SatelliteLogbook',             'Satellite Logbook',                                        'LOG',       '{}', 'Activities, travel, battery cycles, antenna deployments, connector matings. Travels with the satellite.'),
  ('SYS', 'TREP', 'InterfacesVerification',       'Interfaces Verification Report',                           'IFV-RPT',   '{}', 'As-run ESA Interfaces Verification Procedure for PocketQubes.'),
  ('SYS', 'TREP', 'SatelliteInspection',          'Satellite Inspection Report',                              'SAT-IRPT',  '{}', 'As-run ESA Inspection Procedure for PocketQubes, repeated before and after shipment and tests.'),
  ('SYS', 'VCD',  'EquipmentQualificationStatus', 'Equipment Qualification Status List',                      'EQSL',      '{}', 'In the ESA D1.60 data package for CubeSats only.'),
  -- Subsystem tests
  ('TTC', 'TPLN', 'AntennaTest',                  'Antenna Test Plan',                                        null,        '{SYS}', null),
  ('TTC', 'TSTP', 'AntennaTest',                  'Antenna Test Specification and Procedure',                 null,        '{SYS}', null),
  ('TTC', 'TREP', 'AntennaTest',                  'Antenna Test Report',                                      null,        '{SYS}', null),
  ('TTC', 'TREP', 'LongRange2',                   'Second Long Range Test Report',                            null,        '{}', null),
  ('ELE', 'TPLN', 'BatteryPack',                  'Battery Pack Test Plan',                                   null,        '{SYS}', null),
  ('ELE', 'TSTP', 'BatteryPackAcceptance',        'Battery Pack Acceptance Test Specification and Procedure', null,        '{SYS}', null),
  ('ELE', 'TREP', 'BatteryPackAcceptance',        'Battery Pack Acceptance Test Report',                      null,        '{SYS}', null),
  -- Design and analysis of the subsystems
  ('TTC', 'DREP', 'AntennaMechanism',             'Antenna Deployment Mechanism Design Report',               null,        '{}', null),
  ('TTC', 'DREP', 'COMMSArchitecture',            'COMMS Architecture',                                       null,        '{}', null),
  ('TTC', 'AREP', 'LinkDataBudget',               'Link and Data Budget Analysis Report',                     null,        '{}', null),
  -- Functional test campaign
  ('SYS', 'TSTP', 'FullFunctionalTest',           'Full Functional Test Specification and Procedure',         'FFT-TSTP',  '{}', null),
  ('SYS', 'TSTP', 'MissionTest',                  'Mission Test Specification and Procedure',                 'MIS-TSTP',  '{}', 'May include the end-to-end test.'),
  ('SYS', 'TREP', 'FullFunctionalTest',           'Full Functional Test Report',                              'FFT-TRPT',  '{}', null),
  ('SYS', 'TREP', 'MissionTest',                  'Mission Test Report',                                      'MIS-TRPT',  '{}', null),
  -- Reduced functional test
  ('SYS', 'TSTP', 'QMReducedFunctionalTest',      'QM Reduced Functional Test Specification and Procedure',   null,        '{}', null),
  ('SYS', 'TREP', 'QMReducedFunctionalTest',      'QM Reduced Functional Test Report',                        null,        '{}', null),
  ('SYS', 'TSTP', 'ReducedFunctionalTest',        'FM Reduced Functional Test Specification and Procedure',   'RFT-TSTP',  '{}', 'Run before and after each environmental test and each transport.'),
  ('SYS', 'TREP', 'ReducedFunctionalTest',        'FM Reduced Functional Test Report',                        'RFT-TRPT',  '{}', null),
  -- Operations and ground segment
  ('SYS', 'MAN',  'SatelliteOperations',          'Operations Manual',                                        'OPS-MAN',   '{}', null),
  ('SYS', 'TREP', 'OperationsValidation',         'Operational Procedures Validation',                        'OPS-VAL',   '{}', 'Procedures, TM and TC validated, with set-up and software versions.'),
  ('TTC', 'TREP', 'GroundStationTest',            'Ground Station Test Report',                               'GS-TRPT',   '{SYS}', 'Recommended tests in Annex 1 of the Phase D DRDs.'),
  -- Requirements compliance, legal and regulatory
  ('SYS', 'VCD',  'TechnicalSpecification',       'Technical Specification Verification Control Document',    'TS-VCD',    '{}', 'Kept in the VCD tool of the FYS portal.'),
  ('SYS', 'VCD',  'FYSDesignSpecification',       'FYS Design Specification Verification Control Document',   'FDS-VCD',   '{}', 'Kept in the VCD tool of the FYS portal.'),
  ('MGT', 'PLAN', 'RegistrationAuthorisation',    'Registration and Authorisation Status Report',             'REG-AUT',   '{}', null),
  ('SYS', 'AREP', 'SpaceDebrisMitigation',        'Space Debris Mitigation Report',                           'SDMR',      '{}', null),
  -- Environmental tests: qualification model
  ('SYS', 'TPLN', 'QMVibrationTest',              'QM Vibration Test Plan',                                   null,        '{}', null),
  ('SYS', 'TSTP', 'QMVibrationTest',              'QM Vibration Test Specification and Procedure',            null,        '{}', null),
  ('SYS', 'TREP', 'QMVibrationTest',              'QM Vibration Test Report',                                 null,        '{}', null),
  ('SYS', 'TPLN', 'QMThermalVacuumTest',          'QM Thermal Vacuum Test Plan',                              null,        '{}', null),
  ('SYS', 'TSTP', 'QMThermalVacuumTest',          'QM Thermal Vacuum Test Specification and Procedure',       null,        '{}', null),
  ('SYS', 'TREP', 'QMThermalVacuumTest',          'QM Thermal Vacuum Test Report',                            null,        '{}', null),
  -- Environmental test campaign: flight model
  ('SYS', 'TPLN', 'VibrationTest',                'FM Vibration Test Plan',                                   null,        '{}', null),
  ('SYS', 'TSTP', 'VibrationTest',                'FM Vibration Test Specification and Procedure',            'VIBE-TSTP', '{}', 'DRD in the FYS4 Environmental Testing DRDs and Guidelines.'),
  ('SYS', 'TREP', 'VibrationTest',                'FM Vibration Test Report',                                 'VT-TRPT',   '{}', null),
  ('SYS', 'TPLN', 'ThermalVacuumTest',            'FM Thermal Vacuum Test Plan',                              null,        '{}', null),
  ('SYS', 'TSTP', 'ThermalVacuumTest',            'FM Thermal Vacuum Test Specification and Procedure',       'TVAC-TSTP', '{}', 'DRD in the FYS4 Environmental Testing DRDs and Guidelines.'),
  ('SYS', 'TREP', 'ThermalVacuumTest',            'FM Thermal Vacuum Test Report',                            'TVAC-TRPT', '{}', null),
  ('SYS', 'DREP', 'DeclaredMaterials',            'Declared Materials List',                                  'DML',       '{THS}', 'ESA template on the FYS portal.'),
  ('THS', 'AREP', 'StructuralAnalysis',           'Structural Analysis Report',                               'STR-ARPT',  '{}', null),
  ('THS', 'AREP', 'ThermalAnalysis',              'Thermal Analysis Report',                                  'THR-ARPT',  '{}', null),
  ('SYS', 'PLAN', 'SatelliteShipment',            'Shipment Plan',                                            null,        '{}', 'Transport to the ESA test facility: packaging, customs.'),
  ('SYS', 'MAN',  'GroundHandling',               'Ground Handling User Manual',                              'GHUM',      '{}', 'Travels with the satellite: shipment, tests, deployer integration.'),
  ('SYS', 'TREP', 'MDVReport',                    'MDV Report',                                               'MDV-RPT',   '{}', 'Listed in the FAR data package: confirm with ESA what MDV stands for, then rename.'),
  ('ELE', 'TREP', 'BatteryPackSafety',            'Battery Report',                                           'BAT-RPT',   '{}', 'Space debris and launch safety compliance of the batteries; includes the battery log.'),
  -- Configuration control
  ('SYS', 'DREP', 'ProductTree',                  'Spacecraft Product Tree',                                  'SPT',       '{}', 'ESA template on the FYS portal.'),
  ('SFW', 'MAN',  'SoftwareRepository',           'Software Repository',                                      null,        '{}', 'Configuration control of the on-board and ground software.'),
  -- Launch campaign and operations
  ('SYS', 'AREP', 'LaunchSafetyDataPackage',      'Launch and Safety Data Package',                           null,        '{}', null),
  ('SYS', 'PROC', 'PreflightCheckout',            'Pre-flight Check-out Procedure',                           null,        '{}', null),
  ('SYS', 'DREP', 'InterfaceControl',             'Interface Control Document',                               'ICD',       '{}', null),
  ('RED', 'AREP', 'MissionResultsLessonsLearned', 'Post Flight Report: Mission Results and Lessons Learned',  null,        '{}', null)
on conflict (subteam, doc_type, title) do update set
  name = excluded.name, esa_code = excluded.esa_code, note = excluded.note,
  subteams = case when documents.subteams = '{}' then excluded.subteams else documents.subteams end;

-- ---------------------------------------------------------------------
-- 3. Required level at each milestone
-- ---------------------------------------------------------------------
create temp table seed_requirements (file text, milestone text, level text, note text) on commit drop;

insert into seed_requirements values
  ('SYS_DREP_SatelliteProjectFile',         'KOR',      'release', null),
  ('SYS_AREP_FailureModesEffects',          'KOR',      'release', 'FME(C)A deliverable at the KOR.'),

  ('RED_PROC_SatelliteIntegration',         'IFV',      'release', 'As-run procedure with photos and videos of the integration.'),
  ('RED_LOG_SatelliteLogbook',              'IFV',      'ad_hoc',  'Started at the first assembly, kept up to date.'),

  ('SYS_TREP_InterfacesVerification',       'FTC-KO',   'release', null),
  ('SYS_TREP_SatelliteInspection',          'FTC-KO',   'release', 'With the interfaces verification, at the end of the integration.'),
  ('SYS_TSTP_FullFunctionalTest',           'FTC-KO',   'release', null),
  ('SYS_TSTP_MissionTest',                  'FTC-KO',   'release', null),

  ('SYS_TSTP_FullFunctionalTest',           'FFT-PRT',  'update',  'As-run procedure.'),
  ('SYS_MAN_SatelliteOperations',           'MT-TRR',   'release', null),
  ('SYS_TSTP_MissionTest',                  'MT-PRT',   'update',  'As-run procedure.'),

  ('SYS_TREP_FullFunctionalTest',           'D1-CO',    'draft',   null),
  ('SYS_TREP_MissionTest',                  'D1-CO',    'draft',   null),
  ('SYS_VCD_TechnicalSpecification',        'D1-CO',    'update',  'Phase D1 status.'),
  ('SYS_VCD_FYSDesignSpecification',        'D1-CO',    'update',  'Phase D1 status.'),
  ('SYS_MAN_SatelliteOperations',           'D1-CO',    'update',  null),
  ('SYS_TREP_OperationsValidation',         'D1-CO',    'release', null),
  ('MGT_PLAN_RegistrationAuthorisation',    'D1-CO',    'update',  null),

  ('SYS_TSTP_VibrationTest',                'ETC-KO',   'draft',   null),
  ('SYS_TSTP_ThermalVacuumTest',            'ETC-KO',   'draft',   null),
  ('SYS_DREP_DeclaredMaterials',            'ETC-KO',   'update',  null),
  ('THS_AREP_StructuralAnalysis',           'ETC-KO',   'update',  null),
  ('THS_AREP_ThermalAnalysis',              'ETC-KO',   'update',  null),
  ('SYS_PLAN_SatelliteShipment',            'ETC-KO',   'release', 'Part of the environmental test data package.'),
  ('SYS_TSTP_ReducedFunctionalTest',        'ETC-KO',   'release', 'Assumption: not in the ESA list, needed before shipment and tests.'),
  ('SYS_MAN_GroundHandling',                'ETC-KO',   'release', 'Assumption: not in the ESA list, needed before shipment.'),

  ('SYS_TSTP_VibrationTest',                'VT-TRR',   'release', 'Assumption: final version before the test.'),
  ('SYS_TSTP_ThermalVacuumTest',            'TVAC-TRR', 'release', 'Assumption: final version before the test.'),

  ('SYS_TREP_FullFunctionalTest',           'FAR',      'release', null),
  ('SYS_TREP_MissionTest',                  'FAR',      'release', null),
  ('SYS_TREP_VibrationTest',                'FAR',      'release', null),
  ('SYS_TREP_ThermalVacuumTest',            'FAR',      'release', null),
  ('SYS_TREP_MDVReport',                    'FAR',      'release', null),
  ('SYS_VCD_TechnicalSpecification',        'FAR',      'update',  'Phase D2 status: requirements closed.'),
  ('SYS_VCD_FYSDesignSpecification',        'FAR',      'update',  'Phase D2 status: requirements closed.'),
  ('SYS_MAN_SatelliteOperations',           'FAR',      'update',  null),
  ('TTC_TREP_GroundStationTest',            'FAR',      'release', 'At the latest for the FAR.'),
  ('ELE_TREP_BatteryPackSafety',            'FAR',      'release', 'TBC by ESA.'),
  ('SYS_AREP_SpaceDebrisMitigation',        'FAR',      'update',  null),
  ('MGT_PLAN_RegistrationAuthorisation',    'FAR',      'update',  null),
  ('SYS_AREP_LaunchSafetyDataPackage',      'FAR',      'draft',   'TBC by ESA, depends on the launch.'),
  ('SYS_TREP_SatelliteInspection',          'FAR',      'ad_hoc',  'Inspections before and after shipment and tests.'),
  ('SYS_TREP_ReducedFunctionalTest',        'FAR',      'ad_hoc',  'After each RFT; may be part of the vibration and TVAC reports.'),
  ('SYS_DREP_ProductTree',                  'FAR',      'ad_hoc',  'As-built configuration.'),
  ('SFW_MAN_SoftwareRepository',            'FAR',      'ad_hoc',  'Flight software baseline.'),

  ('SYS_AREP_LaunchSafetyDataPackage',      'LAUNCH',   'release', null),
  ('SYS_PROC_PreflightCheckout',            'LAUNCH',   'release', null),
  ('SYS_DREP_InterfaceControl',             'LAUNCH',   'release', null),
  ('SYS_MAN_GroundHandling',                'LAUNCH',   'update',  'Assumption: deployer integration, pre-flight tests and maintenance.'),

  ('RED_AREP_MissionResultsLessonsLearned', 'PFR',      'release', null);

do $$
begin
  if exists (select 1 from seed_requirements r
             where not exists (select 1 from public.documents d
                               where d.subteam || '_' || d.doc_type || '_' || d.title = r.file)
                or not exists (select 1 from public.milestones m where m.code = r.milestone)) then
    raise exception 'Seed: unknown document or milestone';
  end if;
end $$;

insert into public.document_requirements (milestone_id, document_id, level, note)
select m.id, d.id, r.level, r.note
from seed_requirements r
join public.documents  d on d.subteam || '_' || d.doc_type || '_' || d.title = r.file
join public.milestones m on m.code = r.milestone
on conflict (milestone_id, document_id) do update set level = excluded.level, note = excluded.note;

commit;
