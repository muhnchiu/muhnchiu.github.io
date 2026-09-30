export type ProcessIdentityResolution =
  | { status: 'RUNNING'; startIdentity: string }
  | { status: 'EXITED' }
  | { status: 'UNKNOWN'; reason: string };

export function resolveProcessIdentity(pid: number): ProcessIdentityResolution;
export function parseLinuxProcStatStartTicks(statText: string): string | undefined;
export function isValidProcessStartIdentity(value: unknown, platform?: string): boolean;
