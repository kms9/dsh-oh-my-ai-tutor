# 资料检索、研究依据与源码索引

> 记录本项目研究所使用的**官方资料、第三方实测、仓库和可审计代码位置**。整理时间 2026-11-11；链接指向当时检查的项目文件或稳定文档页，实施前应固定源码版本/commit。下列链接存在不等于这些组件已经完成联调。

## A. Heptabase：产品基线和教学工作流

| 来源 | URL | 主要用于核验 | 注意 |
| --- | --- | --- | --- |
| Heptabase AI Tutor 官方介绍 | https://heptabase.com/ai-tutor | Goal/Syllabus/Lesson/互动教学/Notes 产品定位 | 公开营销/产品资料，不等于内部 API |
| Heptabase 官方更新日志 | https://wiki.heptabase.com/changelog | 产品迭代和能力时间差 | 不把后续 AI Agent 功能等同于所有 Tutor 功能 |
| 官方相关 YouTube 演示 | https://www.youtube.com/watch?v=GFiM6hnlkgQ | 辅助观察交互流程 | 本研究未获得可逐帧验证的视频内容，不能凭视频推定未证实操作 |
| Zenn 使用者实测 | https://zenn.dev/hizacra/articles/d4a1369334ce29 | 建课、计划、Lesson、Review、课程调整、知识整理 | 个人体验，非效果实验 |
| Substack 实验报告 | https://obsidianacademicnotamaking.substack.com/p/260410-ai-heptabase-ai-tutor | 不同学科中进入新知识领域的体验 | 个人体验，非可信的学习增益数据 |
| 独立 Skill | https://github.com/togo13duke/heptabase-ai-tutor-skill | 可执行 Skill、Markdown 状态、理解检查、恢复机制 | 非官方，非 UI 完整替代品 |
| 第三方逆向整理 | https://github.com/MarlinDiary/hepta-mirror | Goal Setup / Course / Lesson / Review 等阶段边界参考 | 不作为有授权的原文复制源，版本早于当期官方 |

## B. DSH：宿主架构和插件能力

| 仓库/文档 | URL | 用途 |
| --- | --- | --- |
| DSH 主仓库 | https://github.com/deepseek-ai/deepseek-harness | Cordis 插件式 Agent 宿主 |
| 架构 | https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md | Profile/Bundle、插件组合、Web/Desktop |
| Skills | https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/skills.md | Tutor Skill 注入与作用域 |
| Storage | https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/storage.md | 计划中领域持久化改造（`ctx.storageDomain`） |
| Sessions | https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md | 对话事件与长期业务状态分离 |
| Web Slots | https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/slots.md | Native UI 插件扩展点 |
| Client Architecture | https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/web-client.md | Host/Client API、React 插件 UI |
| User Questions | https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/user-questions.md | 用户确认和人工决策面 |
| Subagents | https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md | Syllabus/Part/Review/Notes Worker 的可选分工 |
| MCP | https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/mcp.md | 外部教材和工具能力 |
| Schedule | https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/schedule.md | 长期复习任务候选能力 |

## C. StudyHub：优先源数据、课程总纲和知识骨架

- 仓库：https://github.com/EricWang1358/dsh-web-studyhub
- 接口与权责：[`docs/architecture.md`](https://github.com/EricWang1358/dsh-web-studyhub/blob/main/docs/architecture.md)、[`lib/runtime/lifecycle.js`](https://github.com/EricWang1358/dsh-web-studyhub/blob/main/lib/runtime/lifecycle.js)
- 课程总纲：[`docs/course-outline.zh-CN.md`](https://github.com/EricWang1358/dsh-web-studyhub/blob/main/docs/course-outline.zh-CN.md)、[`lib/contexts/generation/outline/`](https://github.com/EricWang1358/dsh-web-studyhub/tree/main/lib/contexts/generation/outline)
- Knowledge Skeleton：[`lib/skeleton.js`](https://github.com/EricWang1358/dsh-web-studyhub/blob/main/lib/skeleton.js)；`part-of/causes/contrasts/prerequisite/example-of/related` 六类关系
- 只读图形导航：[`docs/uml-canvas.md`](https://github.com/EricWang1358/dsh-web-studyhub/blob/main/docs/uml-canvas.md)
- 当前与拟议流程边界：[`docs/study-workflows.zh-CN.md`](https://github.com/EricWang1358/dsh-web-studyhub/blob/main/docs/study-workflows.zh-CN.md)

## D. LookatStudy：学习状态与教学交互

- 仓库：https://github.com/Kaiji-Z/dsh-plugin-lookatstudy
- DSH 插件激活与上下文：[`src/index.ts`](https://github.com/Kaiji-Z/dsh-plugin-lookatstudy/blob/main/src/index.ts)
- 状态模型：[`src/state.ts`](https://github.com/Kaiji-Z/dsh-plugin-lookatstudy/blob/main/src/state.ts)
- 工具注册：[`src/tools.ts`](https://github.com/Kaiji-Z/dsh-plugin-lookatstudy/blob/main/src/tools.ts)
- BKT 算法：[`src/vendor/bkt.ts`](https://github.com/Kaiji-Z/dsh-plugin-lookatstudy/blob/main/src/vendor/bkt.ts)
- SM-2 算法：[`src/vendor/sm2.ts`](https://github.com/Kaiji-Z/dsh-plugin-lookatstudy/blob/main/src/vendor/sm2.ts)
- 概念图：[`src/client/diagrams.ts`](https://github.com/Kaiji-Z/dsh-plugin-lookatstudy/blob/main/src/client/diagrams.ts)，当前为 Lesson→KC 星型图
- 课程树：[`src/client/maprail.tsx`](https://github.com/Kaiji-Z/dsh-plugin-lookatstudy/blob/main/src/client/maprail.tsx)
- 验证协议：[`VERIFICATION.md`](https://github.com/Kaiji-Z/dsh-plugin-lookatstudy/blob/main/VERIFICATION.md)

## E. dsh-whiteboard：画布编辑协议

- 仓库：https://github.com/Fantasy421/dsh-whiteboard
- 四个工具与更新步骤：[`docs/ai-tools.md`](https://github.com/Fantasy421/dsh-whiteboard/blob/main/docs/ai-tools.md)
- Tool 注册：[`src/index.mjs`](https://github.com/Fantasy421/dsh-whiteboard/blob/main/src/index.mjs)
- 图形与元素验证：[`src/model.mjs`](https://github.com/Fantasy421/dsh-whiteboard/blob/main/src/model.mjs)
- 按 Session 组织白板：[`src/workspace.mjs`](https://github.com/Fantasy421/dsh-whiteboard/blob/main/src/workspace.mjs)
- CAS、并发和限制：[`docs/data-and-safety.md`](https://github.com/Fantasy421/dsh-whiteboard/blob/main/docs/data-and-safety.md)
- 尚需真实 GUI 验收：[`docs/verification.md`](https://github.com/Fantasy421/dsh-whiteboard/blob/main/docs/verification.md)

## F. 可选生态（非当前强依赖）

- DSH Aha Tutor：https://github.com/BaronCyrus/dsh-aha-tutor
- DSH Anki：https://github.com/NanoShiki/dsh-anki
- DSH Noteboard：https://github.com/boogoo619/dsh-noteboard
- OpenViking：https://github.com/volcengine/OpenViking
- WeKnora：https://github.com/Tencent/WeKnora
- FSRS TypeScript：https://github.com/open-spaced-repetition/ts-fsrs
- FSRS Go：https://github.com/open-spaced-repetition/go-fsrs
- 解析器：https://github.com/docling-project/docling ，https://github.com/opendatalab/MinerU

## G. 用户提供的领域知识背景

以下四份原始研究材料已在项目对话环境中提供。由于 GitHub 仓库当前是 **public**，未确认材料的公开分发许可，因此远端仓库仅保留 [`research/user-materials/README.md`](../research/user-materials/README.md) 所述的材料索引与用途，不包含原始 Markdown / Canvas：

- `个性化教育理论基础和教学方法发展.md`：理论基础、苏格拉底、布鲁姆、ZPD、支架、UbD、PBL。
- `教育心理学知识图谱-六大维度的溯源.md`：认知、动机、发展、行为、测评、学习差异的溯源和 2026 语境。
- `教育心理学概念地图.canvas`：教育心理学概念图源文件。
- `个性化学习框架_汇报展示版.canvas`：个性化学习框架白板源文件。

完整原文仅保留在本次项目的受限工作环境，不纳入公开 Git 仓库。本原型尚不能自动解析 Canvas，也未全面验证文件中每一项学术引用。后续确需上传时，应先确认公开分发许可。
