// Research & Topic shared utilities

// Topic slug → display name mapping
const topicNames: Record<string, string> = {
  'agent-systems': 'Agent Systems',
  'local-ai': 'Local AI',
  'ai-coding': 'AI Coding',
  'frontier-models': 'Frontier Models',
  'open-models': 'Open Models',
  'inference': 'Inference',
  'mcp': 'MCP',
  'security': 'Security',
  'developer-tools': 'Developer Tools',
  'mac-apps': 'Mac Apps',
  'workflow': 'Workflow',
  'edge-computing': 'Edge Computing',
  'serverless': 'Serverless',
  'python': 'Python',
  'openai-models': 'OpenAI Models',
  'anthropic-models': 'Anthropic Models',
  'free-api': 'Free API',
  'ai-training-data': 'AI Training Data',
  'supply-chain': 'Supply Chain',
  'infrastructure': 'Infrastructure',
};

export function topicLabel(slug: string): string {
  return topicNames[slug] || slug;
}

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
