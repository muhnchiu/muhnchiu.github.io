/** Canonical Topic identifiers accepted by Radar validation. */
export const RADAR_CANONICAL_TOPIC_IDS = [
  'frontier-models',
  'open-models',
  'local-ai',
  'multimodal',
  'agent-systems',
  'ai-coding',
  'inference',
  'rag-knowledge',
  'model-economics',
  'developer-tools',
  'engineering-productivity',
  'software-productivity',
  'ai-security',
  'software-supply-chain',
  'frontier-research',
] as const;

export const RADAR_CANONICAL_TOPIC_SET: ReadonlySet<string> = new Set(RADAR_CANONICAL_TOPIC_IDS);
