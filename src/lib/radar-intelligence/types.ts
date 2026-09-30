export type RelevanceLevel = 'DIRECT' | 'ADJACENT' | 'EXPLORATORY' | 'UNRELATED';
export type RadarCategory = 'ai' | 'dev' | 'app' | 'skill' | 'sec';
export type SecurityGate = 'N/A' | 'DIRECTLY_EXPOSED' | 'DEPENDENCY_RELEVANT' | 'ECOSYSTEM_RELEVANT' | 'UNRELATED';
export type RadarSignal = 'high' | 'medium' | 'low' | 'filtered';
export type RadarAction = 'adopt' | 'test' | 'read' | 'watch' | 'ignore';
export type RiskLevel = 'low' | 'normal' | 'high';

export interface SecurityEscalation {
  activeExploitation?: boolean;
  supplyChainImpact?: boolean;
  reachableDependency?: boolean;
  officialEmergencyAdvisory?: boolean;
}

export interface RadarPolicyInput {
  relevanceLevel: RelevanceLevel;
  relevanceScore: number;
  impact: number;
  actionability: number;
  novelty: number;
  confidence: number;
  momentum: number;
  /** Pre-resolved modifier carried by the frozen replay/pipeline input. */
  radarModifier: number;
  securityGate: SecurityGate;
  securityEscalation?: SecurityEscalation;
  priorValidation: boolean;
  risk: RiskLevel;
  duplicate: boolean;
  eventType: string;
}

export interface RadarPolicyEvent {
  id: number;
  date: string;
  radar: RadarCategory;
  title: string;
  entity: string;
  input: RadarPolicyInput;
}

export interface RadarPolicyResult {
  scoreVersion: '2.0';
  baseScore: number;
  directBonus: number;
  modifier: number;
  finalScore: number;
  signal: RadarSignal;
  action: RadarAction;
  filtered: boolean;
  filterReason: string | null;
}

export interface ModifierTriggers {
  priceOrCostChange?: boolean;
  capabilityChange?: boolean;
  modelRelease?: boolean;
  contextTool?: boolean;
  aiCodingWorkflowTool?: boolean;
  trainingResearch?: boolean;
  newSkillRelease?: boolean;
  nonMaterialSkillUpdate?: boolean;
  stackComponentMatch?: boolean;
  productivityTool?: boolean;
  genericConsumerApp?: boolean;
  aiSecurityTopic?: boolean;
  ecosystemCritical?: boolean;
}
