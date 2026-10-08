# 日常运行与维护

[返回项目入口](../README.md) · [下一章：排障](07-troubleshooting.md)

## 每日检查

1. 检查五类页面是否有预期日期的报告。
2. 检查 verdict、highlights、正文和来源是否完整，确认不是占位内容。
3. 缺报时逐层核对采集、分析、公开 Markdown、Git、Actions 和页面。
4. 对照实际调度定义与执行日志；Gateway 重启或模型超时可能中断分析。
5. 将手动恢复和下一次自动批次验收分别记录。

时区约定为 Asia/Shanghai；实际任务时间、模型和 timeout 以当前本地调度定义为准。手册早期时间表不可直接当作今天的 cron。调度器可能来自 OpenClaw、launchd 或 cron，不能假设只检查一个来源即可。

## 网站开发命令

在网站仓库运行：

```bash
npm ci
npm run dev
npm run build
npm run preview
```

开发服务器展示原始简体内容；构建生成默认繁体和 `/zh-hans/` 简体路由。`prebuild` 包含策略分发检查、契约检查、Contract、Validator 和 Registry 测试；其他 evidence、score-input、phase4 等测试入口见 `package.json`，不属于每次 build 都执行的全集。

本章命令是维护说明，本次文档整理没有执行这些命令。正式修复时按任务范围选择测试，不能在只读审计中运行写入 dist 的 build。

## Legacy Publisher

`script-manager/publishers/publish-radar.sh` 读取私有归档中的可发布报告，目标为网站的 `src/content/radar/`。使用前阅读其当前 README 与参数。

它的 README 说明：正常模式成功后会暂存报告、commit 并 push；`--no-git` 仍可能复制内容和构建，不能视为只读。即使参数叫 dry-run，也需核查实现及允许的副作用，不能据名称推断零写入。

发布应明确具体日期、文件、编辑范围和 Git / 部署权限。失败后遵守当次 STOP 条件，先提出可审查修复，不能因最终可成功而跳过续行授权。

## Actions 与 Pages

`.github/workflows/deploy.yml` 在 main push 或手动触发时运行，使用 Node.js 24、`npm ci`、`npm run build`，上传 dist 并部署。Pages 工作流并发组会取消进行中的旧运行。

验收需记录提交 SHA、实际工作流结果、页面日期与公开内容。一条失败的历史或并行工作流不能单独说明当前网站失败；同样，成功工作流也不能代替逐类内容检查。

## 安全维护边界

调度调整、生产重跑、Registry 写入、发布、授权管理分别判断权限。保留源材料和证据；不把日志、认证配置、个人技术栈或私有状态直接放入公开仓库。
