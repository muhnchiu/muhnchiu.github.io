import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const darwinStartLookup = String.raw`
import ctypes, os, sys

pid = int(sys.argv[1])
class ProcBsdInfo(ctypes.Structure):
    _fields_ = [
        ('pbi_flags', ctypes.c_uint32), ('pbi_status', ctypes.c_uint32),
        ('pbi_xstatus', ctypes.c_uint32), ('pbi_pid', ctypes.c_uint32),
        ('pbi_ppid', ctypes.c_uint32), ('pbi_uid', ctypes.c_uint32),
        ('pbi_gid', ctypes.c_uint32), ('pbi_ruid', ctypes.c_uint32),
        ('pbi_rgid', ctypes.c_uint32), ('pbi_svuid', ctypes.c_uint32),
        ('pbi_svgid', ctypes.c_uint32), ('rfu_1', ctypes.c_uint32),
        ('pbi_comm', ctypes.c_char * 16), ('pbi_name', ctypes.c_char * 32),
        ('pbi_nfiles', ctypes.c_uint32), ('pbi_pgid', ctypes.c_uint32),
        ('pbi_pjobc', ctypes.c_uint32), ('e_tdev', ctypes.c_uint32),
        ('e_tpgid', ctypes.c_uint32), ('pbi_nice', ctypes.c_int32),
        ('pbi_start_tvsec', ctypes.c_uint64), ('pbi_start_tvusec', ctypes.c_uint64),
    ]

libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
proc_pidinfo = libproc.proc_pidinfo
proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
proc_pidinfo.restype = ctypes.c_int
info = ProcBsdInfo()
size = ctypes.sizeof(info)
result = proc_pidinfo(pid, 3, 0, ctypes.byref(info), size)
if result != size or info.pbi_pid != pid:
    sys.exit(3)
print(f'{info.pbi_start_tvsec}:{info.pbi_start_tvusec}')
`;

function pidSignalState(pid) {
  try {
    process.kill(pid, 0);
    return 'RUNNING';
  } catch (error) {
    if (error?.code === 'ESRCH') return 'EXITED';
    return 'UNKNOWN';
  }
}

export function parseLinuxProcStatStartTicks(statText) {
  if (typeof statText !== 'string') return undefined;
  const close = statText.lastIndexOf(')');
  if (close < 0) return undefined;
  const fields = statText.slice(close + 1).trim().split(/\s+/);
  const startTicks = fields[19]; // proc stat field 22; the remainder begins at field 3.
  return /^\d+$/.test(startTicks ?? '') ? startTicks : undefined;
}

export function isValidProcessStartIdentity(value, platform = process.platform) {
  if (typeof value !== 'string') return false;
  if (platform === 'darwin') {
    const match = /^darwin:(\d+):(\d+)$/.exec(value);
    return Boolean(match && Number(match[2]) <= 999_999);
  }
  if (platform === 'linux') return /^linux:\d+$/.test(value);
  return false;
}

function unknown(reason) {
  return { status: 'UNKNOWN', reason };
}

/** Resolve process birth identity from kernel metadata. Unavailable metadata is never treated as exit. */
export function resolveProcessIdentity(pid) {
  if (!Number.isInteger(pid) || pid < 1) return unknown('INVALID_PID');
  const before = pidSignalState(pid);
  if (before === 'EXITED') return { status: 'EXITED' };
  if (before !== 'RUNNING') return unknown('PID_LIVENESS_UNKNOWN');

  if (process.platform === 'linux') {
    try {
      const statText = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const startTicks = parseLinuxProcStatStartTicks(statText);
      if (!startTicks) return unknown('LINUX_START_TICKS_UNAVAILABLE');
      return { status: 'RUNNING', startIdentity: `linux:${startTicks}` };
    } catch {
      return pidSignalState(pid) === 'EXITED' ? { status: 'EXITED' } : unknown('LINUX_PROC_STAT_UNAVAILABLE');
    }
  }

  if (process.platform === 'darwin') {
    try {
      const start = execFileSync('/usr/bin/python3', ['-I', '-c', darwinStartLookup, String(pid)], {
        encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (!/^\d+:\d+$/.test(start)) return unknown('DARWIN_PROC_PIDINFO_INVALID');
      if (pidSignalState(pid) === 'EXITED') return { status: 'EXITED' };
      return { status: 'RUNNING', startIdentity: `darwin:${start}` };
    } catch {
      return pidSignalState(pid) === 'EXITED' ? { status: 'EXITED' } : unknown('DARWIN_PROC_PIDINFO_UNAVAILABLE');
    }
  }

  return unknown(`UNSUPPORTED_PLATFORM:${process.platform}`);
}
