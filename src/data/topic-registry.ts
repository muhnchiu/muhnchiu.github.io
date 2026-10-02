import type { TopicDefinition, TopicGroup } from './topic-types';

// Canonical Topic Governance V2. Content relations are derived from published Markdown.
export const topicRegistry: TopicDefinition[] = [
  { slug: 'frontier-models', name: '前沿模型', description: '追踪前沿模型的能力演进、发布节奏与竞争格局。', group: 'models', status: 'active', order: 1 },
  { slug: 'open-models', name: '开放模型', description: '观察开放权重模型的能力、生态与应用边界。', group: 'models', status: 'active', order: 2 },
  { slug: 'local-ai', name: '本地智能', description: '研究模型在个人设备与本地环境中的运行和应用。', group: 'models', status: 'active', order: 3 },
  { slug: 'multimodal', name: '多模态', description: '观察文字、图像、语音与视频能力的融合。', group: 'models', status: 'active', order: 4 },
  { slug: 'agent-systems', name: '智能体系统', description: '研究智能体的工具使用、协作方式与系统架构。', group: 'systems', status: 'active', order: 5 },
  { slug: 'ai-coding', name: '智能编程', description: '追踪 AI 辅助编程与软件开发工作流的变化。', group: 'systems', status: 'active', order: 6 },
  { slug: 'inference', name: '推理与基础设施', description: '研究模型推理效率、部署方式与基础设施。', group: 'systems', status: 'active', order: 7 },
  { slug: 'rag-knowledge', name: '知识与检索', description: '观察知识组织、检索增强与可信回答系统。', group: 'systems', status: 'active', order: 8 },
  { slug: 'model-economics', name: '模型经济', description: '追踪模型定价、成本结构与商业化路径。', group: 'systems', status: 'active', order: 9 },
  { slug: 'developer-tools', name: '开发者工具', description: '观察开发工具、平台与工程工作方式的演进。', group: 'tools', status: 'active', order: 10 },
  { slug: 'engineering-productivity', name: '工程效率', description: '研究工程实践、自动化与团队交付效率。', group: 'tools', status: 'active', order: 11 },
  { slug: 'software-productivity', name: '数字生产力', description: '关注数字工具如何改变个人与团队的工作方式。', group: 'tools', status: 'active', order: 12 },
  { slug: 'ai-security', name: '智能安全', description: '追踪 AI 系统的安全边界、风险与防护实践。', group: 'security', status: 'active', order: 13 },
  { slug: 'software-supply-chain', name: '软件供应链', description: '观察软件依赖、构建与交付链路中的安全风险。', group: 'security', status: 'active', order: 14 },
  { slug: 'frontier-research', name: '前沿研究', description: '记录可能改变未来技术方向的早期研究信号。', group: 'security', status: 'active', order: 15 },
];

export const canonicalTopicSlugs: ReadonlySet<string> = new Set(topicRegistry.map(({ slug }) => slug));
