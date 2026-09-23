export const homeSnapshot = {
  latestRadarDate: '2026.09.23',
  lastScan: '2026.09.23 09:15 CST',
};

export const radars = [
  { name: 'AI', icon: '✦', signals: 3, states: ['2 TEST', '1 WATCH'], href: '/radar/ai', accent: 'blue' },
  { name: 'DEVELOPER', icon: '</>', signals: 4, states: ['1 TEST', '2 WATCH', '1 READ'], href: '/radar/dev', accent: 'green' },
  { name: 'SECURITY', icon: '♢', signals: 2, states: ['1 ACTION', '1 WATCH'], href: '/radar/security', accent: 'red' },
  { name: 'APP / SOFTWARE', icon: '◇', signals: 5, states: ['2 TEST', '2 WATCH', '1 READ'], href: '/radar/app', accent: 'purple' },
  { name: 'AGENT SKILLS', icon: '⌘', signals: 6, states: ['3 EXPLORE', '2 WATCH', '1 READ'], href: '/radar/skill', accent: 'orange' },
];

export const briefs = [
  { tag: 'SECURITY / VULNERABILITY', action: 'ACTION', title: 'CVE-2024-XXXXX：影响主流开源组件的高危漏洞', summary: '存在被利用风险，建议尽快评估并安排补丁。', time: '2h ago' },
  { tag: 'AI / MODEL', action: 'TEST', title: 'Claude 3.5 Sonnet 新能力更新', summary: '在工具调用和代码能力上有明显提升，值得进入测试列表。', time: '4h ago' },
  { tag: 'DEVELOPER / TOOL', action: 'WATCH', title: 'VS Code Insiders 推出 AI 原生工作区', summary: '新的 Agent 模式正在逐步开放，建议持续关注。', time: '6h ago' },
  { tag: 'AI / RESEARCH', action: 'READ', title: 'OpenAI 发布长上下文评测基准', summary: '为长上下文能力提供了更系统的评估方法，有助于理解模型边界。', time: '8h ago' },
  { tag: 'APP / SOFTWARE', action: 'READ', title: 'Notion 推出新一代 AI 知识管理功能', summary: '在企业知识协作方向迈出重要一步，值得关注其后续发展。', time: '10h ago' },
];

export const recentResearch = [
  ['09.22', 'Agent Skills 正在成为新的 AI 能力封装层', 'AGENT　 SKILL　 EVOLVING'],
  ['09.21', 'Local LLM 在企业场景的实际应用探索', 'LOCAL AI　 DEPLOYMENT'],
  ['09.20', 'MCP：AI 应用的通用连接层', 'MCP　 STANDARD'],
  ['09.19', '开发者效率工具的新范式', 'DEVELOPER　 PRODUCTIVITY'],
  ['09.18', 'AI 安全：从模型对齐到应用防护', 'SECURITY　 SAFETY'],
] as const;
