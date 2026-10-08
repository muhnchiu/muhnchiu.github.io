# 五套雷达

[返回项目入口](../README.md) · [下一章：流水线](04-pipeline.md)

| Radar | 关注范围 | 阅读后要回答的问题 | 网站目录 |
| --- | --- | --- | --- |
| AI | 模型、论文、推理、多模态与 Agent | 是否值得测试，是否影响技术路线？ | `ai` |
| DEV | 工具、协作、工程实践、AI Coding | 是否改善当前开发流程？ | `dev` |
| SKILL | Skills、MCP、能力成熟度与复用 | 能否纳入日常工作流？ | `skill` |
| APP | 效率应用、独立软件与替代品 | 是否值得安装或替换？ | `app` |
| SEC | 漏洞、公告、利用证据与依赖影响 | 是否影响环境，是否需要处置？ | `security` |

## 来源范围

手册记录的 AI 来源包括官方厂商信息、Hugging Face Papers / Models、GitHub、OpenRouter、arXiv 和 TechCrunch AI；APP 包括 Hacker News、Product Hunt、少数派、小众软件和 AlternativeTo；SEC 包括 NVD、GitHub Security Advisories、CISA KEV 与安全社区信息。

这些是历史来源示例，不是当前可用性承诺。DEV、SKILL 完整来源清单及各来源重试行为应从 `script-manager/radars/` 的现行脚本核对；不能仅凭手册认定每个来源今天采集成功。

## 如何阅读

先检查日期和报告覆盖情况，再读 verdict、正式 highlights 和正文来源。High 是信号强度，行动建议是建议处理方式，两者不是执行授权。

安全条目还需核对技术栈影响、利用状态与冻结 Security Gate；单个 CVE 的严重度不足以独自决定个人处置优先级。

## 跨雷达关联

同一事件可能关联多个雷达。V2 使用主归属和关联关系减少重复表达；身份规则必须遵守 Event / Observation Policy。不能以标题变化认定新事件，也不能把设计目标描述成 Legacy 已经实现的跨雷达全量去重。

## 每日报告覆盖

逐类检查采集、分析文件、网站 Markdown 和公开页面。某类没有重点可能是过滤结果、来源不足或任务失败，必须结合日志与报告说明判断，不能用空模板冒充成功。
