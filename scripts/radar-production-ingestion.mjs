#!/usr/bin/env node
import { createContinuousProductionIngestion } from '../src/lib/radar-production-registry/continuous-ingestion.mjs';

const [command, ...args] = process.argv.slice(2);
const runtime = createContinuousProductionIngestion();
const print = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

try {
  if (command === 'status') print(await runtime.status());
  else if (command === 'enable') print(await runtime.enable());
  else if (command === 'disable') print(await runtime.disable());
  else if (command === 'scheduler-enable') print(await runtime.enableScheduler());
  else if (command === 'scheduler-disable') print(await runtime.disableScheduler());
  else if (command === 'health') print(await runtime.health());
  else if (command === 'verify-registry') print(await runtime.verifyRegistry());
  else if (command === 'run-once') {
    const summary = await runtime.runOnce({ trigger: 'OPERATOR', replayCount: 5 });
    await runtime.disable('RUN_ONCE_WINDOW_COMPLETE');
    print(summary);
    if (summary.finalStatus !== 'RUN_SUCCESS') process.exitCode = 1;
  } else if (command === 'scheduler-validation') {
    const scheduledAt = args[0] ?? new Date().toISOString();
    const summary = await runtime.schedulerTrigger({ scheduledAt });
    print(summary);
    if (summary.finalStatus !== 'RUN_SUCCESS') process.exitCode = 1;
  } else if (command === 'scheduler-dispatch') {
    const summary = await runtime.schedulerDispatch({ scheduledAt: args[0] ?? new Date().toISOString() });
    print(summary);
    if (summary.finalStatus !== 'RUN_SUCCESS') process.exitCode = 1;
  } else if (command === 'scheduler-dry-run') {
    const summary = await runtime.schedulerDryRun({ scheduledAt: args[0] ?? new Date().toISOString() });
    print(summary);
    if (summary.finalStatus !== 'DRY_RUN_SUCCESS') process.exitCode = 1;
  } else {
    process.stderr.write('Usage: node scripts/radar-production-ingestion.mjs status|enable|disable|scheduler-enable|scheduler-disable|run-once|health|verify-registry|scheduler-validation|scheduler-dispatch|scheduler-dry-run [scheduledAt]\n');
    process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ code: error.code ?? 'RUNTIME_ERROR', message: error.message })}\n`);
  process.exitCode = 1;
}
