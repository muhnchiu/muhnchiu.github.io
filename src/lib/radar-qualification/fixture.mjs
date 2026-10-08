import {FIELDS, PINS, canonical, sha256, responseSchema} from '../radar-judgment/provider.mjs';
import {exact, time, fail} from '../radar-bootstrap/index.mjs';

const hash = v => sha256(canonical(v));
const eq = (a,b) => canonical(a) === canonical(b);
const fixtureKeys = ['profile','type','fixtureVersion','rubricId','rubricVersion','rubricHash','qualificationProtocolVersion','expectedSchemaVersion','expectedSchemaHash','providerTarget','modelTarget','qualificationPurpose','localScope','localObservationId','localRecordIdentity','observedAt','normalizedCandidateFacts','evidenceFixture','expectedAssessment'];
const evidenceKeys = ['label','authority','type','evidenceRef','bytes','sha256','claimBindings','recordIdentity','versionIdentity','scope','observationId','observedAt','validFrom','validUntil'];

/** Authored evidence uses literal local identities; derived wire IDs never enter its hash. */
export function fixtureBinding(fixture, rubric) {
  exact(fixture,fixtureKeys);
  exact(fixture.providerTarget,['providerId','adapterVersion','adapterHash','endpointClass','authenticationMechanism','credentialSourceRef','authenticationBindingRevision']);
  exact(fixture.modelTarget,['modelId','observableVersionStatus','observableVersion','configurationFingerprint']);
  if (Object.values(fixture.providerTarget).some(v=>typeof v!=='string'||!v) ||
      !/^[a-f0-9]{64}$/.test(fixture.providerTarget.adapterHash) ||
      !/^[a-f0-9]{64}$/.test(fixture.modelTarget.configurationFingerprint) ||
      typeof fixture.modelTarget.modelId!=='string' || !fixture.modelTarget.modelId ||
      !['OBSERVABLE','UNOBSERVABLE'].includes(fixture.modelTarget.observableVersionStatus) ||
      (fixture.modelTarget.observableVersionStatus==='UNOBSERVABLE' ? fixture.modelTarget.observableVersion!==null : typeof fixture.modelTarget.observableVersion!=='string'||!fixture.modelTarget.observableVersion)) fail('QUALIFICATION_TARGET_INVALID');
  if (fixture.profile!=='NON_PRODUCTION_PROVIDER_QUALIFICATION_INPUT_1.0' ||
      fixture.type!=='NON_PRODUCTION_PROVIDER_QUALIFICATION_SAMPLE' ||
      fixture.rubricId!==rubric.rubricId || fixture.rubricVersion!=='1.0' || fixture.rubricHash!==PINS.payload ||
      fixture.qualificationProtocolVersion!=='1.0' || fixture.expectedSchemaVersion!=='EXISTING_JUDGMENT_RESPONSE_SCHEMA_1.0' ||
      fixture.expectedSchemaHash!==hash(responseSchema) || fixture.qualificationPurpose!=='CONNECTIVITY_SCHEMA_PROVENANCE_BINDING_STABILITY' ||
      typeof fixture.fixtureVersion!=='string' || !fixture.fixtureVersion ||
      ![fixture.localScope,fixture.localObservationId,fixture.localRecordIdentity].every(v=>typeof v==='string'&&v.startsWith('qualification-local:'))) fail('QUALIFICATION_FIXTURE_INVALID');
  time(fixture.observedAt);
  exact(fixture.evidenceFixture,FIELDS); exact(fixture.expectedAssessment,FIELDS);
  const refs=new Set();
  for (const field of FIELDS) {
    const spec=rubric.fields.find(s=>s.field===field), rows=fixture.evidenceFixture[field];
    if (!Array.isArray(rows) || rows.length!==spec.evidenceTypes.length) fail('QUALIFICATION_EVIDENCE_INCOMPLETE');
    const types=new Set();
    for (const row of rows) {
      exact(row,evidenceKeys); time(row.observedAt); time(row.validFrom); if(row.validUntil!==null)time(row.validUntil);
      if (row.label!=='NON_PRODUCTION_PROVIDER_QUALIFICATION_EVIDENCE' || row.authority!=='HORIZON_RADAR_OWNER_APPROVED_QUALIFICATION_FIXTURE' ||
          !spec.evidenceTypes.some(t=>t.type===row.type) || types.has(row.type) ||
          typeof row.evidenceRef!=='string' || !row.evidenceRef.startsWith('qualification-evidence:') || refs.has(row.evidenceRef) ||
          typeof row.bytes!=='string' || !row.bytes || row.bytes.length>262144 || sha256(row.bytes)!==row.sha256 ||
          row.scope!==fixture.localScope || row.observationId!==fixture.localObservationId || row.recordIdentity!==fixture.localRecordIdentity ||
          typeof row.versionIdentity!=='string' || !row.versionIdentity || row.observedAt!==fixture.observedAt ||
          !Array.isArray(row.claimBindings) || !row.claimBindings.length || new Set(row.claimBindings).size!==row.claimBindings.length ||
          row.claimBindings.some(c=>typeof c!=='string'||!c) || time(row.validFrom)>time(fixture.observedAt) ||
          (row.validUntil!==null&&time(row.validUntil)<time(fixture.observedAt))) fail('QUALIFICATION_EVIDENCE_BINDING_INVALID');
      refs.add(row.evidenceRef);types.add(row.type);
    }
    validateAssessment(fixture.expectedAssessment[field],field,rows,spec);
  }
  const evidenceFixtureHash=hash(fixture.evidenceFixture);
  const identityObject={type:fixture.type,qualificationProtocolVersion:fixture.qualificationProtocolVersion,fixtureVersion:fixture.fixtureVersion,
    rubricId:fixture.rubricId,rubricVersion:fixture.rubricVersion,rubricHash:fixture.rubricHash,evidenceFixtureHash,
    expectedSchemaVersion:fixture.expectedSchemaVersion,expectedSchemaHash:fixture.expectedSchemaHash,
    providerTarget:fixture.providerTarget,modelTarget:fixture.modelTarget,qualificationPurpose:fixture.qualificationPurpose};
  const digest=hash(identityObject),qualificationSampleId='pqsample:sha256:'+digest;
  const eventKey='provider-qualification:'+digest+':fixture',observationId='pq-observation:'+digest;
  const projectionMap={scope:{from:fixture.localScope,to:eventKey},observationId:{from:fixture.localObservationId,to:observationId},recordIdentity:{from:fixture.localRecordIdentity,to:qualificationSampleId}};
  const projectedEvidence=Object.fromEntries(FIELDS.map(f=>[f,fixture.evidenceFixture[f].map(row=>({...row,scope:eventKey,observationId,recordIdentity:qualificationSampleId}))]));
  return {qualificationSampleId,identityObject,fixtureHash:hash(fixture),evidenceFixtureHash,projectionMap,projectionMapHash:hash(projectionMap),projectedEvidence,projectedEvidenceHash:hash(projectedEvidence),eventKey,observationId};
}

export function validateAssessment(result,field,rows,spec) {
  exact(result,['field','value','reasonCode','assessments']);
  if(result.field!==field||!Array.isArray(result.assessments)||result.assessments.length!==11)fail('QUALIFICATION_ASSESSMENT_INVALID');
  const ids=new Set(),used=new Set();
  for(const a of result.assessments){
    exact(a,['predicateId','state','proofs']);
    if(!spec.levels.some(l=>l.predicateId===a.predicateId)||ids.has(a.predicateId)||!['TRUE','FALSE','UNKNOWN'].includes(a.state)||!Array.isArray(a.proofs)||(a.state!=='UNKNOWN'&&!a.proofs.length))fail('QUALIFICATION_ASSESSMENT_INVALID');
    ids.add(a.predicateId);
    for(const p of a.proofs){exact(p,['evidenceRef','claimId','sha256']);if(!rows.some(r=>r.evidenceRef===p.evidenceRef&&r.sha256===p.sha256&&r.claimBindings.includes(p.claimId)))fail('QUALIFICATION_PROOF_INVALID');used.add(p.evidenceRef);}
  }
  const selected=spec.levels.filter(l=>result.assessments.find(a=>a.predicateId===l.predicateId).state==='TRUE').at(-1);
  if(!selected||selected.value!==result.value||selected.reasonCode!==result.reasonCode||
     spec.levels.some(l=>l.value>selected.value&&result.assessments.find(a=>a.predicateId===l.predicateId).state==='UNKNOWN')||
     spec.evidenceTypes.some(t=>!rows.some(r=>r.type===t.type&&used.has(r.evidenceRef))))fail('QUALIFICATION_RUBRIC_RESULT_INVALID');
}

/** One synthetic repetition with explicit negative comparisons, no live record or inferred source authority. */
export function createAuthoredFixture({rubric,providerTarget,modelTarget,observedAt}) {
  const facts={
    impact:'Complete synthetic scope consists only of task compile in core workflow build. Prior/current catalog entry fixture-tool version 1.0, description stable, supported task compile, procedure compile input.txt, expected output OK, cost 1 unit, capacity 1 task are byte-identical. There are zero additions, corrections, behavior differences, procedure revisions, affected tasks, workflow deltas, broken contracts, newly feasible outcomes, capability replacements or limit crossings. Core designation was fixed before comparison. Both observations produced OK at 1 unit. The complete catalog and integration graph are identical.',
    actionability:'Synthetic retired isolated environment fixture-lab is physically destroyed, with no endpoints, runtime, resources or recoverable data. Owner retired it permanently before observedAt and explicitly prohibits and rules out every monitoring, investigation, preparation, experimentation and intervention response for that environment. Complete plan and permissions lookup shows no response plan, trigger, procedure, scheduled response, deadline or immediate mandate. No response can be executed and no preparatory response exists; no theoretical response is proposed.',
    confidence:'The synthetic target assertion set contains exactly one assertion: fixture-tool compile returned OK. One synthetic primary origin, fixture-tool maintainer test harness, directly owns and observed the assertion; its signed synthetic log states compile input.txt returned OK. Complete provenance chain has exactly this one independently originating firsthand official/primary origin within its authority. No second origin, community origin, ecosystem origin, secondhand chain, rumor label, cross-source corroboration or method cross-verification exists after exhaustive lookup. This is fictional qualification evidence, not a real official source attestation.',
    novelty:'Complete bounded synthetic catalog at cutoff contains only fixture-tool 1.0 and capability compile. Prior and current information have identical project identity, version, capability availability, behavioral guarantee output OK, workflow compile input.txt, explanatory text stable and metadata. Actual prior/current outcomes both OK. No defect fix, editorial/metadata delta, explanatory detail, feature or task-set change, new project, capability class, mechanism, execution contract or incompatible paradigm exists. Exhaustive comparison covers every claim and catalog item.'
  };
  const localScope='qualification-local:synthetic-scope-1',localObservationId='qualification-local:observation-1',localRecordIdentity='qualification-local:record-1';
  const evidenceFixture={},expectedAssessment={};
  for(const field of FIELDS){const spec=rubric.fields.find(f=>f.field===field);
    evidenceFixture[field]=spec.evidenceTypes.map(t=>{const bytes=canonical({label:'NON_PRODUCTION_PROVIDER_QUALIFICATION_EVIDENCE',evidenceClass:t.description,facts:facts[field],synthetic:true});return {label:'NON_PRODUCTION_PROVIDER_QUALIFICATION_EVIDENCE',authority:'HORIZON_RADAR_OWNER_APPROVED_QUALIFICATION_FIXTURE',type:t.type,evidenceRef:'qualification-evidence:'+t.type.toLowerCase(),bytes,sha256:sha256(bytes),claimBindings:[field+':complete-comparison'],recordIdentity:localRecordIdentity,versionIdentity:'synthetic-fixture-1.0',scope:localScope,observationId:localObservationId,observedAt,validFrom:observedAt,validUntil:null};});
    const selected=field==='confidence'?7:0;
    expectedAssessment[field]={field,value:selected,reasonCode:spec.levels.find(l=>l.value===selected).reasonCode,assessments:spec.levels.map(l=>({predicateId:l.predicateId,state:l.value===selected?'TRUE':'FALSE',proofs:evidenceFixture[field].map(r=>({evidenceRef:r.evidenceRef,claimId:r.claimBindings[0],sha256:r.sha256}))}))};
  }
  const fixture={profile:'NON_PRODUCTION_PROVIDER_QUALIFICATION_INPUT_1.0',type:'NON_PRODUCTION_PROVIDER_QUALIFICATION_SAMPLE',fixtureVersion:'1.0',rubricId:rubric.rubricId,rubricVersion:'1.0',rubricHash:PINS.payload,qualificationProtocolVersion:'1.0',expectedSchemaVersion:'EXISTING_JUDGMENT_RESPONSE_SCHEMA_1.0',expectedSchemaHash:hash(responseSchema),providerTarget,modelTarget,qualificationPurpose:'CONNECTIVITY_SCHEMA_PROVENANCE_BINDING_STABILITY',localScope,localObservationId,localRecordIdentity,observedAt,normalizedCandidateFacts:{synthetic:true,entity:'fixture-tool',title:'Synthetic complete repetition',sourceFamily:'NON_PRODUCTION_QUALIFICATION'},evidenceFixture,expectedAssessment};
  fixtureBinding(fixture,rubric);return fixture;
}
