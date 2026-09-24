// Research display utilities. Topic names come from the canonical registry.

// Status mapping
const statusLabels: Record<string, string> = {
  evolving: '持续演进',
  stable: '相对稳定',
  archived: '已归档',
};

export function statusLabel(status: string): string {
  return statusLabels[status] || status;
}

// Confidence mapping
const confidenceLabels: Record<string, string> = {
  high: '高置信度',
  medium: '中等置信度',
  low: '低置信度',
};

export function confidenceLabel(conf: string): string {
  return confidenceLabels[conf] || conf;
}

// Date formatting
export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll('-', '.');
}

// Compare dates for sorting
export function byDateDesc<T>(a: T, b: T, key: (item: T) => Date): number {
  return key(b).getTime() - key(a).getTime();
}
