export const radarCatalog = [
  { id: 'ai', name: 'AI', description: 'Models · APIs · Open Source · Agent · Research' },
  { id: 'dev', name: 'Developer', description: 'Tools · Platforms · Infrastructure · Workflow' },
  { id: 'security', name: 'Security', description: 'Vulnerabilities · Threats · Defensive practice' },
  { id: 'app', name: 'App', description: 'Software · Productivity · Personal computing' },
  { id: 'skill', name: 'Skill', description: 'Agent skills · MCP · Capability packages' },
] as const;

export const signalPriority = { critical: 0, high: 1, medium: 2, low: 3 } as const;

export const formatRadarDate = (value: Date) => value.toISOString().slice(0, 10);
export const displayRadarDate = (value: Date) => formatRadarDate(value).replaceAll('-', '.');
