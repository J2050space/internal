-- =====================================================================
-- J2050 internal tools - migration 011
-- Scope: initial data of the document module.
--   * 5 milestones of the FYS documentation timeline (dates set later by
--     the admins from the site).
--   * Documents required by ESA, named according to the J2050
--     Documentation Manual ([SUBTEAM]_[TYPE]_[Title]); no versions yet,
--     no responsible (assigned from the site).
--   * Required level of each document at each milestone, with a short
--     note on the expected content.
-- Source: FYS documentation timeline prepared with Gemini from
-- ESA-DG-SET-2020-1731, ESA-TEC-PET-2021-1822, ESA-TEC-PET-2021-1823.
-- NCR, RFD and RFW are created when needed: no fixed document.
-- Prerequisite: migration 010 applied.
-- Run once in Supabase > SQL Editor. Runs as one transaction.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. Milestones
-- ---------------------------------------------------------------------
insert into public.milestones (code, name, phase, sort_order, note) values
  ('PDR',     'Preliminary Design Review and Requirements Review', 'B/C',   10,
   'Requirements consolidated (TS-VCD), preliminary architecture, first drafts.'),
  ('CDR',     'Critical Design Review',                            'C',     20,
   'Design freeze: release of all core documents. RFD submitted if needed.'),
  ('TRR-TRB', 'Test Readiness Review and Test Review Board',       'D1',    30,
   'Assembly, integration and functional tests: procedures before the TRR, reports for the TRB. NCR opened for every anomaly.'),
  ('AR',      'Environmental Tests and Acceptance Review',         'D2',    40,
   'Vibration and TVAC campaign, as-built configuration. All NCR closed or covered by an approved RFW before the review.'),
  ('FRR',     'Flight Readiness Review, Launch and Operations',    'E1/E2', 50,
   'Launch safety package, final authorisations, launch campaign, operations and post-mission reports.');

-- ---------------------------------------------------------------------
-- 2. Documents
-- ---------------------------------------------------------------------
insert into public.documents (subteam, doc_type, title, name, esa_code, note) values
  -- System engineering
  ('SYS', 'DREP', 'MissionDescriptionOperations',      'Mission Description and Operations Plan',                       'MDO',       null),
  ('SYS', 'DREP', 'DesignDefinitionJustification',     'Design Definition and Justification File',                      'DDJF',      null),
  ('SYS', 'VCD',  'TechnicalSpecification',            'Technical Specification and Verification Control Document',     'TS-VCD',    null),
  ('SYS', 'VCD',  'FYSDesignSpecification',            'FYS Design Specification Verification Control Document',        'FDS-VCD',   null),
  ('SYS', 'MAN',  'SatelliteOperations',               'Operations Manual (flight and ground)',                          'OPS-MAN',   null),
  ('SYS', 'MAN',  'GroundHandling',                    'Ground Handling User Manual',                                    'GHUM',      null),
  ('SYS', 'AREP', 'LaunchSafetyDataPackage',           'Launcher and Launch Site Safety Data Package',                   'SAFETY-DP', null),
  ('SYS', 'AREP', 'MissionOperationsResults',          'Mission and Operations Report',                                  'M-RPT',     null),
  -- Verification and testing
  ('SYS', 'PLAN', 'AssemblyIntegrationVerification',   'Manufacturing, Assembly, Integration and Verification Plan',     'MAIVP',     null),
  ('SYS', 'VCD',  'EquipmentQualificationStatus',      'Equipment Qualification Status List',                            'EQSL',      null),
  ('RED', 'PROC', 'SatelliteIntegration',              'Assembly and Integration Procedure',                             'AI-PRO',    null),
  ('SYS', 'TREP', 'InterfacesVerification',            'Interfaces Verification Report',                                 'IFV-RPT',   'As-run FYS3 Interfaces Verification Procedure.'),
  ('SYS', 'TREP', 'SatelliteInspection',               'CubeSat Inspection Report',                                      'CUB-IRPT',  'As-run FYS3 Inspection Procedure.'),
  ('SYS', 'TSTP', 'FullFunctionalTest',                'Full Functional Test Specification and Procedures',              'FFT-TSTP',  null),
  ('SYS', 'TREP', 'FullFunctionalTest',                'Full Functional Test Report',                                    'FFT-TRPT',  null),
  ('SYS', 'TSTP', 'ReducedFunctionalTest',             'Reduced Functional Test Specification and Procedures',           'RFT-TSTP',  null),
  ('SYS', 'TREP', 'ReducedFunctionalTest',             'Reduced Functional Test Report',                                 'RFT-TRPT',  null),
  ('SYS', 'TSTP', 'MissionTest',                       'Mission Test Specification and Procedures',                      'MIS-TSTP',  null),
  ('SYS', 'TREP', 'MissionTest',                       'Mission Test Report',                                            'MIS-TRPT',  null),
  ('SYS', 'TSTP', 'VibrationTest',                     'Vibration Test Specification and Procedures',                    'VIBE-TSTP', null),
  ('SYS', 'TREP', 'VibrationTest',                     'Vibration Test Report',                                          'VIBE-TRPT', null),
  ('SYS', 'TSTP', 'ThermalVacuumTest',                 'Thermal Vacuum Test Specification and Procedures',               'TVAC-TSTP', null),
  ('SYS', 'TREP', 'ThermalVacuumTest',                 'Thermal Vacuum Test Report',                                     'TVAC-TRPT', null),
  ('SYS', 'TREP', 'OperationsValidation',              'Operations Validation Report',                                   'OPS-VAL',   null),
  ('TTC', 'TREP', 'GroundStationTest',                 'Ground Station Test Report',                                     'GS-TRPT',   null),
  ('THS', 'AREP', 'StructuralAnalysis',                'Structural Analysis Report',                                     'ARPT',      null),
  ('THS', 'AREP', 'ThermalAnalysis',                   'Thermal Analysis Report',                                        'ARPT',      null),
  ('SYS', 'AREP', 'OrbitAnalysis',                     'Orbit Analysis Report',                                          'ARPT',      null),
  ('SYS', 'AREP', 'RadiationAnalysis',                 'Radiation Analysis Report',                                      'ARPT',      null),
  -- Product assurance
  ('SYS', 'AREP', 'FailureModesEffects',               'Failure Modes and Effects Analysis',                             'FMEA',      null),
  ('SYS', 'DREP', 'FaultDetectionIsolationRecovery',   'FDIR Concept Report',                                            'FDIR',      null),
  ('SYS', 'DREP', 'DeclaredMaterials',                 'Declared Materials List',                                        'DML',       'ESA template [AD10].'),
  ('SYS', 'DREP', 'ProductTree',                       'CubeSat Product Tree',                                           'CPT',       'ESA template [AD9].'),
  ('ELE', 'TREP', 'BatteryPackSafety',                 'Battery Report',                                                 'BAT-RPT',   'Required for ISS deployment or if requested by the launch provider.'),
  ('RED', 'LOG',  'SatelliteLogbook',                  'CubeSat Logbook',                                                'LOGBOOK',   'ESA template [RD4].'),
  -- Software
  ('SFW', 'MAN',  'SoftwareRepository',                'Software Repository and Documentation (flight, payload, ground station, EGSE)', 'SW-REPO', null),
  -- Regulatory and project management
  ('SYS', 'AREP', 'SpaceDebrisMitigation',             'Space Debris Mitigation Report',                                 'SDMR',      'Compliance matrix: Annex H of ESSB-HB-U-002.'),
  ('MGT', 'PLAN', 'RegistrationAuthorisation',         'Registration and Authorisation Status Report',                   'REG_AUT',   null),
  ('MGT', 'PLAN', 'ProjectManagement',                 'Project Management Plan',                                        'PMP',       null),
  ('RED', 'MAN',  'LessonsLearned',                    'Lessons Learned Report',                                         'LL-RPT',    null);

-- ---------------------------------------------------------------------
-- 3. Required level at each milestone
-- ---------------------------------------------------------------------
create temp table seed_requirements (file text, milestone text, level text, note text) on commit drop;

insert into seed_requirements values
  ('SYS_DREP_MissionDescriptionOperations', 'PDR',     'draft',   'Mission objectives, preliminary ConOps, orbit requirements.'),
  ('SYS_DREP_MissionDescriptionOperations', 'CDR',     'release', 'Operational modes, activation sequence (LEOP), nominal pass timeline, critical periods.'),
  ('SYS_DREP_MissionDescriptionOperations', 'TRR-TRB', 'update',  'Updated with functional and mission test results (boot times, TM/TC).'),

  ('SYS_DREP_DesignDefinitionJustification', 'PDR',    'draft',   'Preliminary architecture, main component selection, first budgets with margins.'),
  ('SYS_DREP_DesignDefinitionJustification', 'CDR',    'release', 'Design freeze: quick facts table, CAD and ICD, all budgets (mass, power, link, data, pointing, radiation).'),

  ('SYS_VCD_TechnicalSpecification', 'PDR',     'release', 'Technical specification baseline: numbered, verifiable, traced requirements.'),
  ('SYS_VCD_TechnicalSpecification', 'CDR',     'update',  'Verification method, level and phase; requirements closed by review of design and analysis.'),
  ('SYS_VCD_TechnicalSpecification', 'TRR-TRB', 'update',  'Compliance status with test and inspection reports.'),
  ('SYS_VCD_TechnicalSpecification', 'AR',      'update',  'Environmental requirements closed with vibration and TVAC reports.'),
  ('SYS_VCD_TechnicalSpecification', 'FRR',     'update',  'All requirements closed before launch; deviations covered by approved RFD or RFW.'),

  ('SYS_VCD_FYSDesignSpecification', 'CDR',     'release', 'Design compliance with all FDS requirements (analyses, calculations, datasheets).'),
  ('SYS_VCD_FYSDesignSpecification', 'TRR-TRB', 'update',  'Evidence from inspections and functional tests.'),
  ('SYS_VCD_FYSDesignSpecification', 'AR',      'update',  'Evidence from environmental tests, mass properties and fit check.'),
  ('SYS_VCD_FYSDesignSpecification', 'FRR',     'update',  'Final update before the launch campaign.'),

  ('SYS_MAN_SatelliteOperations', 'TRR-TRB', 'draft',   'Nominal and contingency procedures, to be validated in the mission test.'),
  ('SYS_MAN_SatelliteOperations', 'AR',      'release', 'Validated by the mission test and the system validation tests.'),

  ('SYS_MAN_GroundHandling', 'TRR-TRB', 'draft',   'Handling points, ESD precautions, RBF pins and inhibits, transport.'),
  ('SYS_MAN_GroundHandling', 'AR',      'release', 'Handling for environmental tests and deployer integration.'),
  ('SYS_MAN_GroundHandling', 'FRR',     'update',  'Adapted to the launch provider and the integration site.'),

  ('SYS_AREP_LaunchSafetyDataPackage', 'AR',  'draft',   'Hazard analysis, battery certificates, materials, inhibit schemes.'),
  ('SYS_AREP_LaunchSafetyDataPackage', 'FRR', 'release', 'Signed package with the final acceptance test results.'),

  ('SYS_AREP_MissionOperationsResults', 'FRR', 'release', 'LEOP, commissioning and nominal phase; orbital telemetry against predictions.'),

  ('SYS_PLAN_AssemblyIntegrationVerification', 'PDR', 'draft',   'Model philosophy and verification strategy.'),
  ('SYS_PLAN_AssemblyIntegrationVerification', 'CDR', 'release', 'Models per subsystem, AIV flow, GSE, cleanroom requirements, test plan.'),

  ('SYS_VCD_EquipmentQualificationStatus', 'TRR-TRB', 'release', 'Qualification status of each equipment (example table in the Phase D DRDs).'),
  ('SYS_VCD_EquipmentQualificationStatus', 'AR',      'update',  'Status after the environmental tests.'),

  ('RED_PROC_SatelliteIntegration', 'TRR-TRB', 'release', 'Step-by-step assembly: torques, harness, continuity and insulation checks.'),
  ('SYS_TREP_InterfacesVerification', 'TRR-TRB', 'release', 'Interfaces verified during integration.'),

  ('SYS_TREP_SatelliteInspection', 'TRR-TRB', 'release', 'Dimensions, mass, centre of mass, moments of inertia.'),
  ('SYS_TREP_SatelliteInspection', 'AR',      'update',  'Final as-built inspection: final mass, deployer fit check, photos.'),

  ('SYS_TSTP_FullFunctionalTest', 'TRR-TRB', 'release', 'Agreed with ESA before the TRR.'),
  ('SYS_TREP_FullFunctionalTest', 'TRR-TRB', 'release', 'Results with complete logs, for the TRB.'),
  ('SYS_TREP_FullFunctionalTest', 'AR',      'update',  'Full functional test after the environmental tests: no degradation.'),
  ('SYS_TSTP_ReducedFunctionalTest', 'TRR-TRB', 'release', 'Agreed with ESA before the TRR.'),
  ('SYS_TREP_ReducedFunctionalTest', 'AR',      'release', 'Reduced functional tests before and after each environmental test.'),
  ('SYS_TSTP_MissionTest', 'TRR-TRB', 'release', 'Agreed with ESA before the TRR.'),
  ('SYS_TREP_MissionTest', 'TRR-TRB', 'release', 'Results for the TRB.'),

  ('SYS_TSTP_VibrationTest',     'TRR-TRB', 'draft',   'Draft for the environmental TRR.'),
  ('SYS_TSTP_VibrationTest',     'AR',      'release', 'Agreed with ESA before the test.'),
  ('SYS_TREP_VibrationTest',     'AR',      'release', 'Results and verdict for the TRB and the AR.'),
  ('SYS_TSTP_ThermalVacuumTest', 'TRR-TRB', 'draft',   'Draft for the environmental TRR.'),
  ('SYS_TSTP_ThermalVacuumTest', 'AR',      'release', 'Agreed with ESA before the test.'),
  ('SYS_TREP_ThermalVacuumTest', 'AR',      'release', 'Results and verdict for the TRB and the AR.'),

  ('SYS_TREP_OperationsValidation', 'AR', 'release', 'Validation of the operations with the satellite and the ground segment.'),
  ('TTC_TREP_GroundStationTest',    'AR', 'release', 'Ground station tests and results.'),

  ('THS_AREP_StructuralAnalysis', 'CDR', 'release', 'Supports the DDJF and the VCDs.'),
  ('THS_AREP_ThermalAnalysis',    'CDR', 'release', 'Supports the DDJF and the VCDs.'),
  ('SYS_AREP_OrbitAnalysis',      'CDR', 'release', 'Supports the DDJF and the VCDs.'),
  ('SYS_AREP_RadiationAnalysis',  'CDR', 'release', 'Supports the DDJF and the VCDs.'),

  ('SYS_AREP_FailureModesEffects', 'PDR', 'draft',   'Functional FMEA per subsystem, critical single point failures.'),
  ('SYS_AREP_FailureModesEffects', 'CDR', 'release', 'All subsystems and ground segment, critical item list, mitigations.'),

  ('SYS_DREP_FaultDetectionIsolationRecovery', 'TRR-TRB', 'release', 'FDIR trees, watchdogs, safe mode; validated in the functional tests.'),

  ('SYS_DREP_DeclaredMaterials', 'PDR', 'draft',   'Structural materials and main polymers.'),
  ('SYS_DREP_DeclaredMaterials', 'CDR', 'release', 'Outgassing data of all materials (TML < 1.0 %, CVCM < 0.1 %).'),
  ('SYS_DREP_DeclaredMaterials', 'AR',  'update',  'Materials added during assembly (adhesives, tape, staking), before TVAC.'),

  ('SYS_DREP_ProductTree', 'PDR',     'draft',   'Preliminary breakdown of space and ground segment.'),
  ('SYS_DREP_ProductTree', 'CDR',     'release', 'Complete product tree with unique identifiers.'),
  ('SYS_DREP_ProductTree', 'TRR-TRB', 'update',  'Serial and lot numbers of the flight model components.'),

  ('ELE_TREP_BatteryPackSafety', 'TRR-TRB', 'release', 'Cell screening, capacity and impedance matching, protection circuits.'),

  ('RED_LOG_SatelliteLogbook', 'TRR-TRB', 'release', 'Started with the integration of the flight model.'),
  ('RED_LOG_SatelliteLogbook', 'AR',      'update',  'Activities of the environmental campaign.'),
  ('RED_LOG_SatelliteLogbook', 'FRR',     'update',  'Activities up to the delivery for launch.'),

  ('SFW_MAN_SoftwareRepository', 'PDR',     'draft',   'Repository, folder structure, coding standards.'),
  ('SFW_MAN_SoftwareRepository', 'CDR',     'draft',   'Architecture, state machines, protocols, prototypes.'),
  ('SFW_MAN_SoftwareRepository', 'TRR-TRB', 'release', 'Flight software tested on hardware, frozen with a release tag.'),
  ('SFW_MAN_SoftwareRepository', 'AR',      'ad_hoc',  'Patches after the environmental tests traced by commit and checksum.'),
  ('SFW_MAN_SoftwareRepository', 'FRR',     'ad_hoc',  'Flight software baseline loaded before closure.'),

  ('SYS_AREP_SpaceDebrisMitigation', 'PDR', 'draft',   'First estimate of the orbital decay (25-year rule).'),
  ('SYS_AREP_SpaceDebrisMitigation', 'CDR', 'release', 'DRAMA simulations, compliance matrix, passivation, re-entry analysis.'),
  ('SYS_AREP_SpaceDebrisMitigation', 'AR',  'update',  'Final orbit parameters and as-built mass.'),

  ('MGT_PLAN_RegistrationAuthorisation', 'PDR', 'draft',   'Competent authorities, IARU coordination, ITU API publication.'),
  ('MGT_PLAN_RegistrationAuthorisation', 'CDR', 'release', 'ITU and IARU status, radio licence, launch authorisations, export control.'),
  ('MGT_PLAN_RegistrationAuthorisation', 'AR',  'update',  'Radio licences and national authorisation issued.'),
  ('MGT_PLAN_RegistrationAuthorisation', 'FRR', 'update',  'Registration in the national register and with UNOOSA.'),

  ('MGT_PLAN_ProjectManagement', 'PDR',     'draft',   'Organisation chart, academic support, WBS, preliminary schedule.'),
  ('MGT_PLAN_ProjectManagement', 'CDR',     'release', 'Students, WBS, schedule to launch, budget, risk register, handover plan.'),
  ('MGT_PLAN_ProjectManagement', 'TRR-TRB', 'ad_hoc',  'Schedule, students, organisation and handover plan kept up to date.'),
  ('MGT_PLAN_ProjectManagement', 'AR',      'ad_hoc',  'Schedule, risks and people kept up to date.'),

  ('RED_MAN_LessonsLearned', 'FRR', 'release', 'Technical and management lessons for future teams.');

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
join public.milestones m on m.code = r.milestone;

commit;
