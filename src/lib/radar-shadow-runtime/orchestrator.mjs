import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { adaptProductionCandidate } from '../radar-candidate-adapter/adapters.ts';
import { normalizeEvidence, prepareEvidenceCommit } from '../radar-evidence-pipeline.mjs';
import { EVENT_FACT_FIELDS } from '../radar-event-identity.mjs';
import { generateScoreInputs } from '../radar-score-input/generator.ts';
import { resolveScoreInputEligibility } from '../radar-score-input/eligibility.ts';
import { deriveScorePolicy211PreGateSignal, evaluateScorePolicy211 } from './score-evaluator-v2.1.1.mjs';
import { evaluateSecurityGateV100 } from './security-gate-v1.0.0.mjs';
import { FROZEN_PINS, assertFrozenRuntimePackages } from './frozen-policies.mjs';
import { validateHandoffBatchForRuntime, canonicalizeJcs } from './handoff.mjs';
import { ShadowStateStore } from './state-store.mjs';
import { buildShadowMetrics, safetyInvariantViolations } from './metrics.mjs';
import { disabledResult, shadowEnabled } from './disable.mjs';
import { forbiddenPublicationReceipt, isWouldPublishRequest, makeShadowRecord, ZERO_SIDE_EFFECTS } from './result.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const radarRegistryName = { AI: 'ai', DEV: 'dev', APP: 'app', SEC: 'security' };
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const unique = (values) => [...new Set(values.filter((value) => typeof value === 'string' && value))];
const isoNow = (clock) => {
  const value = clock ? clock() : new Date().toISOString();
  if (typeof value !== 'string' || !value.endsWith('Z') || !Number.isFinite(Date.parse(value))) throw new Error('SHADOW_CLOCK_INVALID');
  return value;
};

function cleanSourceRecord(envelope) {
  const facts = structuredClone(envelope.record.facts);
  // The handoff URL is source-supplied evidence. Copying its exact value into
  // the adapter shape does not infer an identifier or construct a permalink.
  if (typeof envelope.source.sourceUrl === 'string' && !facts.link && !facts.url && !facts.html_url) facts.link = envelope.source.sourceUrl;
  if (envelope.record.sourcePublishedAt && !facts.sourcePublishedAt) facts.sourcePublishedAt = envelope.record.sourcePublishedAt;
  if (envelope.source.sourceAuthority) facts.sourceAuthority = envelope.source.sourceAuthority;
  if (envelope.source.sourceLevel) facts.sourceLevel = envelope.source.sourceLevel;
  return facts;
}

function adaptExplicitHandoffUrl(adapter, envelope) {
  if (!adapter.candidate || typeof envelope.source.sourceUrl !== 'string') return adapter;
  let parsed;
  try { parsed = new URL(envelope.source.sourceUrl); } catch { return adapter; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return adapter;
  adapter.candidate.itemUrl = envelope.source.sourceUrl;
  const sourceUrlReasons = ['MISSING_ITEM_URL'];
  const remaining = adapter.receiptReasons.filter((reason) => !sourceUrlReasons.includes(reason));
  if (!remaining.length && adapter.candidate.title && adapter.candidate.observedAt && adapter.candidate.sourceAuthority) {
    adapter.status = 'CANDIDATE_READY';
    adapter.receiptReasons = [];
  }
  return adapter;
}

function eventFactsFrom(identityResult, sourceFacts) {
  const requested = { ...(isObject(sourceFacts) ? sourceFacts : {}), ...(isObject(identityResult.eventFacts) ? identityResult.eventFacts : {}) };
  return Object.fromEntries(EVENT_FACT_FIELDS.filter((field) => Object.hasOwn(requested, field) && requested[field] !== null && requested[field] !== undefined).map((field) => [field, requested[field]]));
}

function stageRecord({ runId, envelope, receivedAt, inputDigest, sourceFamily }) {
  return makeShadowRecord({ runId, recordId: envelope?.record?.recordId ?? null, radar: envelope?.radar ?? null, sourceFamily, receivedAt, inputDigest });
}

function receipt(row, terminalOutcome, classification, reason) {
  return {
    ...row,
    terminalOutcome,
    persistenceClassification: classification,
    ...(reason ? { errorCode: reason } : {}),
  };
}

function baseErrorRecord({ runId, raw, index, receivedAt, digest, manifestRadar, code }) {
  const safeId = typeof raw?.record?.recordId === 'string' && raw.record.recordId ? raw.record.recordId : `invalid-row-${index + 1}`;
  const sourceFamily = typeof raw?.source?.sourceName === 'string' ? raw.source.sourceName : null;
  const row = stageRecord({ runId, envelope: { radar: raw?.radar ?? manifestRadar, record: { recordId: safeId } }, receivedAt, inputDigest: digest, sourceFamily });
  row.candidateDisposition = 'CANDIDATE_REJECTED';
  row.candidateReason = code;
  row.errorCode = code;
  row.persistenceClassification = 'RECEIPT_ONLY';
  row.terminalOutcome = 'ERROR';
  return row;
}

async function resolveIdentity({ envelope, candidate }, deps) {
  if (typeof deps.identityResolver !== 'function') return { status: 'UNRESOLVED', reason: 'IDENTITY_AUTHORITY_UNRESOLVED' };
  let result;
  try { result = await deps.identityResolver({ envelope, candidate }); }
  catch { return { status: 'UNRESOLVED', reason: 'IDENTITY_RESOLVER_FAILED' }; }
  if (!isObject(result) || result.status !== 'RESOLVED') return { status: 'UNRESOLVED', reason: result?.reason ?? 'IDENTITY_AUTHORITY_UNRESOLVED' };
  if (typeof result.entity !== 'string' || typeof result.canonicalEventType !== 'string' || typeof result.eventIdentifier !== 'string'
    || !isObject(result.provenance) || typeof result.provenance.authority !== 'string' || !result.provenance.authority
    || typeof result.provenance.ruleId !== 'string' || !result.provenance.ruleId
    || typeof result.provenance.policyVersion !== 'string' || !result.provenance.policyVersion
    || !Array.isArray(result.provenance.evidenceRefs) || !result.provenance.evidenceRefs.includes(candidate.itemUrl)) {
    return { status: 'UNRESOLVED', reason: 'IDENTITY_PROVENANCE_INCOMPLETE' };
  }
  return result;
}

function sourceEvidence(envelope, candidate) {
  const exactUrl = envelope.source.sourceUrl;
  return normalizeEvidence({
    sourceName: candidate.sourceName,
    sourceUrl: exactUrl,
    evidenceRef: exactUrl,
    ...(envelope.record.sourcePublishedAt ? { sourcePublishedAt: envelope.record.sourcePublishedAt } : {}),
  }, { observedAt: envelope.observedAt });
}

async function processAcceptedRecord(envelope, manifest, validation, index, deps, store) {
  const receivedAt = isoNow(deps.clock);
  const sourceFamily = typeof envelope.source?.sourceName === 'string' ? envelope.source.sourceName : null;
  const rowInputDigest = sha(Buffer.from(canonicalizeJcs(envelope), 'utf8'));
  const row = stageRecord({ runId: manifest.runId, envelope, receivedAt, inputDigest: rowInputDigest, sourceFamily });

  if (isWouldPublishRequest(envelope)) return forbiddenPublicationReceipt(row);
  const rowValidation = validation.rowResults[index];
  if (!rowValidation?.valid) {
    const code = rowValidation?.code ?? 'HANDOFF_RECORD_SCHEMA_INVALID';
    const invalid = baseErrorRecord({ runId: manifest.runId, raw: envelope, index, receivedAt, digest: rowInputDigest, manifestRadar: manifest.radar, code });
    if (code === 'SKILL_STRUCTURED_INPUT_UNAVAILABLE') {
      invalid.terminalOutcome = 'RECEIPT_ONLY';
      invalid.candidateDisposition = 'CANDIDATE_REJECTED';
      invalid.persistenceClassification = 'RECEIPT_ONLY';
    }
    return invalid;
  }

  const idKey = sha(`${manifest.runId}\0${envelope.record.recordId}`);
  const prior = await store.readDelivery(idKey);
  if (prior) {
    if (prior.inputDigest !== rowInputDigest) {
      const conflict = receipt({ ...row, duplicate: false }, 'ERROR', 'RECEIPT_ONLY', 'IDEMPOTENCY_CONFLICT');
      conflict.errorCode = 'IDEMPOTENCY_CONFLICT';
      await store.writeError(sha(`${idKey}\0${rowInputDigest}\0IDEMPOTENCY_CONFLICT`), conflict);
      return conflict;
    }
    return { ...prior.record, receivedAt, duplicate: true, retryCount: (prior.retryCount ?? 0) + 1 };
  }

  let adapter;
  try {
    if (envelope.radar === 'SKILL') {
      row.candidateDisposition = 'CANDIDATE_REJECTED';
      row.candidateReason = 'SKILL_STRUCTURED_INPUT_UNAVAILABLE';
      row.errorCode = 'SKILL_STRUCTURED_INPUT_UNAVAILABLE';
      row.terminalOutcome = 'CANDIDATE_REJECTED';
      row.persistenceClassification = 'RECEIPT_ONLY';
    } else {
      adapter = adaptProductionCandidate({ radar: envelope.radar, sourceName: envelope.source.sourceName, record: cleanSourceRecord(envelope) }, { observedAt: envelope.observedAt });
      adapter = adaptExplicitHandoffUrl(adapter, envelope);
      if (!adapter.candidate || adapter.status !== 'CANDIDATE_READY') {
        const reason = unique(adapter.receiptReasons ?? []).join('|') || 'CANDIDATE_ADAPTER_BLOCKED';
        row.candidateDisposition = 'CANDIDATE_REJECTED';
        row.candidateReason = reason;
        row.errorCode = reason;
        const unsupportedReceiptReasons = ['UNKNOWN_SOURCE', 'UNSUPPORTED_SOURCE_RECORD', 'MISSING_ITEM_URL', 'INVALID_ITEM_URL', 'AGGREGATOR_URL_NOT_ITEM'];
        const unsupported = adapter.receiptReasons?.some((reason) => unsupportedReceiptReasons.includes(reason));
        row.terminalOutcome = unsupported ? 'RECEIPT_ONLY' : 'CANDIDATE_REJECTED';
        row.persistenceClassification = 'RECEIPT_ONLY';
      } else {
        row.candidateDisposition = 'CANDIDATE_READY';
        row.candidateReason = null;
        const evidence = sourceEvidence(envelope, adapter.candidate);
        if (!evidence.registryEligible) {
          const reason = unique(evidence.errors.map((entry) => entry.code)).join('|') || 'EVIDENCE_INVALID';
          row.evidenceDisposition = 'INVALID';
          row.evidenceReason = reason;
          row.errorCode = reason;
          row.terminalOutcome = 'RECEIPT_ONLY';
          row.persistenceClassification = 'RECEIPT_ONLY';
        } else {
          row.evidenceDisposition = 'READY';
          row.evidenceReason = null;
          const identityResult = await resolveIdentity({ envelope, candidate: adapter.candidate }, deps);
          if (identityResult.status !== 'RESOLVED') {
            row.identityDisposition = 'UNRESOLVED';
            row.identityReason = identityResult.reason;
            row.errorCode = identityResult.reason;
            row.terminalOutcome = 'IDENTITY_UNRESOLVED';
            row.persistenceClassification = 'RECEIPT_ONLY';
          } else {
            const rawSourceFacts = adapter.candidate.rawSourceMetadata.record;
            const identityFacts = eventFactsFrom(identityResult, rawSourceFacts);
            const prepared = prepareEvidenceCommit({
              sourceName: adapter.candidate.sourceName,
              title: adapter.candidate.title,
              sourceUrl: adapter.candidate.itemUrl,
              evidenceRef: adapter.candidate.itemUrl,
              ...(envelope.record.sourcePublishedAt ? { sourcePublishedAt: envelope.record.sourcePublishedAt } : {}),
              entity: identityResult.entity,
              canonicalEventType: identityResult.canonicalEventType,
              eventIdentifier: identityResult.eventIdentifier,
              eventFacts: identityFacts,
            }, { radar: radarRegistryName[envelope.radar], observedAt: envelope.observedAt });
            if (!prepared.commitRequest) {
              const reason = unique(prepared.errors.map((entry) => entry.code)).join('|') || 'IDENTITY_PREPARATION_FAILED';
              row.identityDisposition = 'UNRESOLVED';
              row.identityReason = reason;
              row.errorCode = reason;
              row.terminalOutcome = 'IDENTITY_UNRESOLVED';
              row.persistenceClassification = 'RECEIPT_ONLY';
            } else {
              row.identityDisposition = 'READY';
              row.identityReason = null;
              adapter.candidate.eventIdentity = {
                entity: identityResult.entity,
                canonicalEventType: identityResult.canonicalEventType,
                eventIdentifier: identityResult.eventIdentifier,
                eventKey: prepared.eventKey,
                evidenceRefs: [adapter.candidate.itemUrl],
                identityEngineVersion: '2.1.2',
              };
              adapter.candidate.evidence = [{
                evidenceRef: adapter.candidate.itemUrl,
                sourceName: adapter.candidate.sourceName,
                sourceAuthority: adapter.candidate.sourceAuthority,
                sourceUrl: adapter.candidate.itemUrl,
                observedAt: envelope.observedAt,
                ...(envelope.record.sourcePublishedAt ? { sourcePublishedAt: envelope.record.sourcePublishedAt } : {}),
              }];

              let securityContext = null;
              if (envelope.radar === 'SEC') {
                if (typeof deps.securityContextProvider !== 'function') {
                  securityContext = { status: 'UNRESOLVED', reason: 'SECURITY_GATE_CONTEXT_UNAVAILABLE' };
                } else {
                  try { securityContext = await deps.securityContextProvider({ envelope, candidate: adapter.candidate, identity: identityResult }); }
                  catch { securityContext = { status: 'UNRESOLVED', reason: 'SECURITY_GATE_CONTEXT_FAILED' }; }
                }
                if (!isObject(securityContext) || securityContext.status !== 'RESOLVED' || !isObject(securityContext.evaluatorInput) || !isObject(securityContext.securityAssessment)) {
                  row.securityDisposition = 'UNRESOLVED';
                  row.securityReason = securityContext?.reason ?? 'SECURITY_GATE_UNRESOLVED';
                  row.errorCode = row.securityReason;
                  row.terminalOutcome = 'SECURITY_GATE_UNRESOLVED';
                  row.persistenceClassification = 'RECEIPT_ONLY';
                }
              } else {
                securityContext = { status: 'NOT_APPLICABLE', securityAssessment: {
                  gate: 'N/A', ruleId: 'SECURITY_GATE_NON_SEC_SCOPE', evidenceRefs: [adapter.candidate.itemUrl],
                  policyVersion: '1.0', authority: 'SECURITY_GATE_POLICY',
                } };
              }

              if (!['UNRESOLVED'].includes(securityContext?.status)) {
                if (typeof deps.scoreInputContextProvider !== 'function') {
                  row.scoreEligibility = 'SCORE_INPUT_INCOMPLETE';
                  row.scoreEligibilityReason = 'SCORE_INPUT_CONTEXT_UNAVAILABLE';
                  row.errorCode = row.scoreEligibilityReason;
                  row.terminalOutcome = 'SCORE_INPUT_INCOMPLETE';
                  row.persistenceClassification = 'RECEIPT_ONLY';
                } else {
                  let scoreContext;
                  try { scoreContext = await deps.scoreInputContextProvider({ envelope, candidate: adapter.candidate, identity: identityResult, securityContext }); }
                  catch { scoreContext = null; }
                  if (!isObject(scoreContext) || !isObject(scoreContext.context)) {
                    row.scoreEligibility = 'SCORE_INPUT_INCOMPLETE';
                    row.scoreEligibilityReason = 'SCORE_INPUT_CONTEXT_INVALID';
                    row.errorCode = row.scoreEligibilityReason;
                    row.terminalOutcome = 'SCORE_INPUT_INCOMPLETE';
                    row.persistenceClassification = 'RECEIPT_ONLY';
                  } else {
                    const generationContext = { ...scoreContext.context, securityAssessment: securityContext.securityAssessment };
                    const generation = await generateScoreInputs(adapter.candidate, generationContext, scoreContext.judgmentProvider);
                    const eligibility = generation.status === 'SCORE_READY'
                      ? resolveScoreInputEligibility({ inputs: generation.inputs, provenance: generation.provenance })
                      : { status: 'RECEIPT_ONLY', reasons: generation.receiptOnlyReasons ?? [] };
                    if (generation.status !== 'SCORE_READY' || eligibility.status !== 'SCORE_READY') {
                      row.scoreEligibility = 'SCORE_INPUT_INCOMPLETE';
                      row.scoreEligibilityReason = unique([...(generation.receiptOnlyReasons ?? []), ...(eligibility.reasons ?? [])]).join('|') || 'SCORE_INPUT_INCOMPLETE';
                      row.errorCode = row.scoreEligibilityReason;
                      row.terminalOutcome = 'SCORE_INPUT_INCOMPLETE';
                      row.persistenceClassification = 'RECEIPT_ONLY';
                    } else {
                      row.scoreEligibility = 'SCORE_READY';
                      row.scoreEligibilityReason = null;
                      const preGate = deriveScorePolicy211PreGateSignal({ inputs: generation.inputs, provenance: generation.provenance });
                      if (preGate.status !== 'READY') {
                        row.scoreEligibility = 'SCORE_INPUT_INCOMPLETE';
                        row.scoreEligibilityReason = preGate.reason ?? 'SCORE_INPUT_PRE_GATE_SIGNAL_UNRESOLVED';
                        row.errorCode = row.scoreEligibilityReason;
                        row.terminalOutcome = 'SCORE_INPUT_INCOMPLETE';
                        row.persistenceClassification = 'RECEIPT_ONLY';
                      } else {
                        const gate = envelope.radar === 'SEC'
                          ? evaluateSecurityGateV100({ ...securityContext.evaluatorInput, radar: 'SEC', incomingSignal: preGate.signal })
                          : evaluateSecurityGateV100({ radar: envelope.radar, applicability: 'NOT_APPLICABLE', applicabilityProvenance: { ruleId: 'SECURITY_GATE_NON_SEC_SCOPE', ruleVersion: '1.0.0', evidenceRefs: [adapter.candidate.itemUrl], applicabilityBasis: 'Frozen policy applies only to SEC.' }, incomingSignal: preGate.signal });
                        if (!gate.scoreEligible || (envelope.radar === 'SEC' && gate.status !== 'RESOLVED')) {
                          row.securityDisposition = 'UNRESOLVED';
                          row.securityReason = unique(gate.reasonCodes ?? []).join('|') || 'SECURITY_GATE_UNRESOLVED';
                          row.errorCode = row.securityReason;
                          row.terminalOutcome = 'SECURITY_GATE_UNRESOLVED';
                          row.persistenceClassification = 'RECEIPT_ONLY';
                        } else {
                          row.securityDisposition = gate.status === 'NOT_APPLICABLE' ? 'NOT_APPLICABLE' : 'RESOLVED';
                          row.securityReason = unique(gate.reasonCodes ?? []).join('|') || null;
                          const score = evaluateScorePolicy211({ inputs: generation.inputs, provenance: generation.provenance, securityGateResult: gate });
                          if (score.status !== 'SCORED') {
                            row.scoreEligibility = 'SCORE_INPUT_INCOMPLETE';
                            row.scoreEligibilityReason = unique(score.reasonCodes ?? []).join('|') || 'SCORE_EVALUATION_INELIGIBLE';
                            row.errorCode = row.scoreEligibilityReason;
                            row.terminalOutcome = 'SCORE_INPUT_INCOMPLETE';
                            row.persistenceClassification = 'RECEIPT_ONLY';
                          } else {
                            row.evaluationDisposition = 'EVALUATED';
                            row.action = score.policyAction;
                            row.terminalOutcome = score.filtered ? 'WOULD_FILTER' : 'WOULD_ACTION';
                            row.persistenceClassification = 'SHADOW_RESULT';
                            row.errorCode = null;
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  } catch {
    row.terminalOutcome = 'ERROR';
    row.persistenceClassification = 'RECEIPT_ONLY';
    row.errorCode = 'SHADOW_RECORD_PROCESSING_ERROR';
  }

  return row;
}

function persistableRecord(row) {
  const allowed = ['runId','recordId','radar','sourceFamily','receivedAt','inputDigest','candidateDisposition','candidateReason','evidenceDisposition','evidenceReason','identityDisposition','identityReason','scoreEligibility','scoreEligibilityReason','securityDisposition','securityReason','evaluationDisposition','action','terminalOutcome','persistenceClassification','retryCount','duplicate','errorCode'];
  return Object.fromEntries(allowed.map((key) => [key, Object.hasOwn(row, key) ? row[key] : null]));
}

async function handleRecord(envelope, manifest, validation, index, deps, store) {
  const rawDigest = sha(Buffer.from(canonicalizeJcs(envelope), 'utf8'));
  const row = await processAcceptedRecord(envelope, manifest, validation, index, deps, store);
  const recordId = row.recordId;
  const deliveryKey = sha(`${manifest.runId}\0${recordId}`);
  if (row.errorCode === 'IDEMPOTENCY_CONFLICT') return row;
  const claim = await store.claimDelivery(deliveryKey, { inputDigest: rawDigest, record: persistableRecord(row), retryCount: 0 });
  if (claim.created) return row;
  if (claim.row?.inputDigest !== rawDigest) {
    const conflict = receipt({ ...row, duplicate: false }, 'ERROR', 'RECEIPT_ONLY', 'IDEMPOTENCY_CONFLICT');
    conflict.errorCode = 'IDEMPOTENCY_CONFLICT';
    await store.writeError(sha(`${deliveryKey}\0${rawDigest}\0IDEMPOTENCY_CONFLICT`), persistableRecord(conflict));
    return conflict;
  }
  return { ...claim.row.record, receivedAt: row.receivedAt, duplicate: true, retryCount: (claim.row.retryCount ?? 0) + 1 };
}

async function persistBatchError(store, input, code) {
  const row = { ...input, terminalOutcome: 'ERROR', persistenceClassification: 'RECEIPT_ONLY', errorCode: code };
  await store.writeError(sha(`${input.runId}\0${input.inputDigest}\0${code}`), row);
  return row;
}

/** Isolated orchestration: no Registry, Publisher, Deployment, V1, Git, or scheduler imports. */
export async function runShadowRuntime(options = {}) {
  if (!shadowEnabled(options.enabled)) return disabledResult();
  let store;
  let bytes;
  try {
    assertFrozenRuntimePackages();
    const root = options.root ?? process.env.HORIZON_RADAR_V2_SHADOW_STATE_DIR;
    if (typeof root !== 'string' || !root.trim()) return { status: 'FAILED', code: 'SHADOW_ROOT_REQUIRED', consumed: false, records: [], sideEffects: ZERO_SIDE_EFFECTS };
    store = options.store ?? new ShadowStateStore(root);
    await store.initialize();
    bytes = options.inputBytes !== undefined ? Buffer.from(options.inputBytes) : options.inputPath ? await readFile(options.inputPath) : null;
    if (!bytes) return { status: 'FAILED', code: 'HANDOFF_SOURCE_MISSING', consumed: false, records: [], sideEffects: ZERO_SIDE_EFFECTS };
    const validation = validateHandoffBatchForRuntime(bytes);
    const failedDigest = validation.digest ?? sha(bytes);
    if (!validation.valid) {
      const runId = `invalid-${failedDigest.slice(0, 16)}`;
      const bad = await persistBatchError(store, { runId, recordId: null, radar: null, sourceFamily: null, receivedAt: isoNow(options.clock), inputDigest: failedDigest }, validation.code ?? 'HANDOFF_INVALID');
      const metrics = buildShadowMetrics({ status: 'FAILED', records: [bad], receivedCount: 0, expectedSourceFamilies: options.expectedSourceFamilies });
      return { status: 'FAILED', consumed: true, outputWritten: true, records: [], errors: [bad], metrics, publicationEvaluation: 'NOT_AVAILABLE', sideEffects: ZERO_SIDE_EFFECTS };
    }
    const { manifest } = validation;
    const initialRun = await store.readRun(manifest.runId);
    if (initialRun && initialRun.inputDigest !== validation.digest) {
      const error = await persistBatchError(store, { runId: manifest.runId, recordId: null, radar: manifest.radar, sourceFamily: null, receivedAt: isoNow(options.clock), inputDigest: validation.digest }, 'RUN_ID_PAYLOAD_CONFLICT');
      return { status: 'FAILED', consumed: true, outputWritten: true, records: [], errors: [error], metrics: buildShadowMetrics({ status: 'FAILED', records: [error], receivedCount: validation.records.length, expectedSourceFamilies: options.expectedSourceFamilies }), publicationEvaluation: 'NOT_AVAILABLE', sideEffects: ZERO_SIDE_EFFECTS };
    }
    const records = [];
    for (let index = 0; index < validation.records.length; index++) {
      try { records.push(await handleRecord(validation.records[index], manifest, validation, index, options, store)); }
      catch {
        records.push(baseErrorRecord({ runId: manifest.runId, raw: validation.records[index], index, receivedAt: isoNow(options.clock), digest: validation.digest, manifestRadar: manifest.radar, code: 'SHADOW_STORAGE_OR_RECORD_ERROR' }));
      }
    }
    const hasErrors = records.some((row) => row.terminalOutcome === 'ERROR');
    const provisionalStatus = hasErrors ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED';
    const metrics = buildShadowMetrics({ status: provisionalStatus, records, receivedCount: validation.records.length, expectedSourceFamilies: options.expectedSourceFamilies });
    const violations = safetyInvariantViolations(metrics);
    const status = violations.length ? 'FAILED' : provisionalStatus;
    if (violations.length) {
      for (const row of records) {
        row.terminalOutcome = 'ERROR';
        row.persistenceClassification = 'RECEIPT_ONLY';
        row.errorCode = violations[0];
      }
    }
    const output = {
      resultVersion: '1.0', runId: manifest.runId, status,
      inputDigest: validation.digest, records: records.map(persistableRecord), metrics,
      publicationEvaluation: 'NOT_AVAILABLE', publisherInvocation: 'FORBIDDEN',
      frozenPins: FROZEN_PINS, sideEffects: ZERO_SIDE_EFFECTS,
      errors: records.filter((row) => row.terminalOutcome === 'ERROR').map((row) => ({ recordId: row.recordId, errorCode: row.errorCode })),
    };
    const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    const files = {
      'metadata.json': json({ resultVersion: output.resultVersion, runId: manifest.runId, radar: manifest.radar, status, inputDigest: validation.digest, recordCount: records.length, createdAt: isoNow(options.clock), publicationEvaluation: 'NOT_AVAILABLE' }),
      'records.jsonl': Buffer.from(`${records.map((row) => JSON.stringify(persistableRecord(row))).join('\n')}${records.length ? '\n' : ''}`, 'utf8'),
      'metrics.json': json(metrics),
      'errors.jsonl': Buffer.from(`${output.errors.map((row) => JSON.stringify(row)).join('\n')}${output.errors.length ? '\n' : ''}`, 'utf8'),
    };
    const publication = await store.publishRun(manifest.runId, validation.digest, files);
    if (publication.conflict) {
      const error = await persistBatchError(store, { runId: manifest.runId, recordId: null, radar: manifest.radar, sourceFamily: null, receivedAt: isoNow(options.clock), inputDigest: validation.digest }, 'RUN_ID_PAYLOAD_CONFLICT');
      return { status: 'FAILED', consumed: true, outputWritten: true, records: [], errors: [error], metrics: buildShadowMetrics({ status: 'FAILED', records: [error], receivedCount: validation.records.length, expectedSourceFamilies: options.expectedSourceFamilies }), publicationEvaluation: 'NOT_AVAILABLE', sideEffects: ZERO_SIDE_EFFECTS };
    }
    return { ...output, consumed: true, outputWritten: true, replay: publication.replay === true, sideEffects: ZERO_SIDE_EFFECTS };
  } catch (error) {
    return { status: 'STORAGE_FAILED', consumed: false, outputWritten: false, records: [], code: error?.message === 'SHADOW_ROOT_NOT_MARKED' ? 'SHADOW_ISOLATION_FAILURE' : 'SHADOW_STATE_ISOLATION_FAILURE', sideEffects: ZERO_SIDE_EFFECTS };
  }
}

export const shadowRuntimePolicyPins = FROZEN_PINS;
export { disabledResult };
