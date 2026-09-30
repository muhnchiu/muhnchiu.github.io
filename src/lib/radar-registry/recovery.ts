import type { RegistryRuntime } from './types.ts';
import { RegistryTransactionManager } from './transaction.ts';

export async function recoverRegistry(runtime: RegistryRuntime): Promise<string> {
  return new RegistryTransactionManager(runtime).recover();
}
