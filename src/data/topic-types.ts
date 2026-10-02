export type TopicGroup = 'models' | 'systems' | 'tools' | 'security';
export type TopicStatus = 'active' | 'watch' | 'archived';

export interface TopicDefinition {
  slug: string;
  name: string;
  description: string;
  group: TopicGroup;
  status: TopicStatus;
  order: number;
}
