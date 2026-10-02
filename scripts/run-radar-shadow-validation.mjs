#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runShadowRuntime } from '../src/lib/radar-shadow-runtime/orchestrator.mjs';
import { aggregateDailyEvidence, privacyGuard } from '../src/lib/radar-shadow-runtime/validation-aggregator.mjs';
import { FROZEN_PINS, assertFrozenRuntimePackages } from '../src/lib/radar-shadow-runtime/frozen-policies.mjs';
import { validateHandoffBatchForRuntime } from '../src/lib/radar-shadow-runtime/handoff.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const args = process.argv.slice(2);
const get = (name) => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
const inputPaths = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--input' && args[i + 1]) inputPaths.push(args[++i]);
const inputKinds = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--input-kind' && args[i + 1]) inputKinds.push(args[++i]);

export async function runValidation({ inputPaths: paths = [], inputKinds = [], stateRoot, date = new Date().toISOString().slice(0, 10), expectedSources = ['AI', 'DEV', 'APP', 'SEC'], runIdPrefix = `validation-${date}`, clock = () => new Date().toISOString() } = {}) {
  if (!stateRoot) throw new Error('SHADOW_VALIDATION_STATE_ROOT_REQUIRED');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('SHADOW_VALIDATION_DATE_INVALID');
  const baseline = assertFrozenRuntimePackages();
  const runs = [];
  const validationRunIds = [];
  for (let index = 0; index < paths.length; index++) {
    const bytes = await readFile(paths[index]);
    const checked = validateHandoffBatchForRuntime(bytes);
    const radar = checked.manifest?.radar ?? 'UNKNOWN';
    const runId = `${runIdPrefix}/${radar}/${sha(bytes).slice(0, 12)}`;
    validationRunIds.push(runId);
    const result = await runShadowRuntime({ enabled: true, root: resolve(stateRoot, `shadow-state-${index}`), inputBytes: bytes, expectedSourceFamilies: [], clock });
    if (result.status === 'STORAGE_FAILED' || result.status === 'FAILED' && !result.records?.length) {
      runs.push({ records: result.records ?? [], recordsReceived: checked.records?.length ?? 0, sourcesObserved: checked.manifest ? [checked.manifest.radar] : [], stateWriteFailures: 1 });
      continue;
    }
    runs.push({
      records: result.records ?? [], recordsReceived: checked.records?.length ?? 0,
      sourcesObserved: checked.manifest ? [checked.manifest.radar] : [],
      stateWriteFailures: result.outputWritten ? 0 : 1,
      productionRegistryWriteCount: result.sideEffects?.productionRegistryWrites ?? 0,
      publisherInvocationCount: result.sideEffects?.publisherCalls ?? 0,
      deploymentCount: result.sideEffects?.deploymentCalls ?? 0,
      v1BehavioralDeltaCount: result.sideEffects?.v1Mutations ?? 0,
      silentFallbackCount: 0,
    });
  }
  const generatedAt = clock();
  const daily = aggregateDailyEvidence({ date, validationRunIds, sourcesExpected: expectedSources, runs, generatedAt });
  const debtPath = resolve(stateRoot, 'policy-debt-observations.jsonl');
  await mkdir(dirname(debtPath), { recursive: true, mode: 0o700 });
  const debtHandle = await open(debtPath, 'a', 0o600);
  try {
    if (daily.policyDebtObserved.length) await debtHandle.write(`${daily.policyDebtObserved.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    await debtHandle.sync();
  } finally { await debtHandle.close(); }
  const evidence = {
    artifact: 'radar-shadow-validation-dry-run-v1', classification: 'EVIDENCE',
    observationWindowStarted: false, isolated: true, runtimeVersion: '1.0.0',
    contractPin: FROZEN_PINS.contract, distributionPin: FROZEN_PINS.distribution,
    scorePolicy: baseline.pins.scorePolicy, securityGate: baseline.pins.securityGate,
    inputCount: paths.length,
    capturedInputs: await Promise.all(paths.map(async (path, index) => {
      const bytes = await readFile(path);
      return { inputIndex: index + 1, inputKind: inputKinds[index] ?? 'STRUCTURED_CAPTURE', sha256: sha(bytes), bytes: bytes.length };
    })),
    dailyEvidence: daily,
    policyDebtObservationEntriesWritten: daily.policyDebtObserved.length,
    productionRegistryWrites: daily.productionRegistryWriteCount,
    publisherInvocations: daily.publisherInvocationCount,
    deployment: daily.deploymentCount,
    v1BehavioralDelta: daily.v1BehavioralDeltaCount,
    silentFallback: daily.silentFallbackCount,
    publicationEvaluation: 'NOT_AVAILABLE',
    wouldPublish: 'FORBIDDEN',
  };
  if (privacyGuard(evidence)) throw new Error('SHADOW_VALIDATION_EVIDENCE_LEAK');
  return evidence;
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
const output = get('--output');
  const stateRoot = get('--state-root') ?? process.env.HORIZON_RADAR_V2_SHADOW_STATE_DIR;
  if (!inputPaths.length || !stateRoot || !output) {
    process.stderr.write('Usage: node scripts/run-radar-shadow-validation.mjs --input HANDOFF.json [--input ...] --state-root TEMP_DIR --output EVIDENCE.json [--date YYYY-MM-DD]\n');
    process.exitCode = 2;
  } else {
    try {
      const result = await runValidation({ inputPaths, inputKinds, stateRoot, date: get('--date') ?? new Date().toISOString().slice(0, 10) });
      await mkdir(dirname(resolve(output)), { recursive: true, mode: 0o700 });
      await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      process.stdout.write(`${JSON.stringify({ dayStatus: result.dailyEvidence.dayStatus, inputCount: result.inputCount, output })}\n`);
    } catch (error) {
      process.stderr.write(`${error.message ?? 'SHADOW_VALIDATION_FAILED'}\n`);
      process.exitCode = 1;
    }
  }
}
