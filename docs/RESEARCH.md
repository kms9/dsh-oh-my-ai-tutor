# 源码研究：DSH 学习插件 × Heptabase AI Tutor

> 研究基线：2026-11-11；检查公开默认分支的 README、docs、部分真实源码与测试。不同项目更新频繁，实施时应锁定 commit/tag。**已在源码定义**不等于**真实端到端验证**。此文不把项目的未实施计划算作当前功能。

## 1. Heptabase：比较基准

官方产品页：https://heptabase.com/ai-tutor
官方更新日志：https://wiki.heptabase.com/changelog
早期提示词研究（不等于官方授权源）：https://github.com/MarlinDiary/hepta-mirror
可执行学习 Skill 参考：https://github.com/togo13duke/heptabase-ai-tutor-skill

官方展示的主链：**学习目标与资料 → 课程大纲 → 每次 Lesson 计划 → Part 教学与交互 → Review → Lesson Note/Whiteboard → 继续下一课**。课程计划可以经反馈更改。Mirror 研究材料将工作分成 `goalSetup/courseCreation/lessonPlanning/lessonTeaching/lessonReview/lessonEnding/planAdjustment`，另有 Syllabus、Part、Note 三种生成子 Agent 的 Prompt 文档。它是早期版本的第三方整理，不能代表 2026 年 11 月全部官方功能，也不是完整可运行程序。其文字的复制/授权存在风险，因此本项目独立编写教学规则。

注意：Heptabase 官方的白板是长期个人知识管理环境，但不应据此断言“AI Tutor 自动输出思维导图、完整语义知识图谱并持续自动双向同步”是必经流程。我们的三种知识可视化是**自主增加的目标能力**。

## 2. StudyHub

仓库：https://github.com/EricWang1358/dsh-web-studyhub
重点源码/文档：
- `docs/architecture.md`：真实 `studyRuntime` 服务、多个 `*.v1` 领域上下文和写入权限/事务；`lib/runtime/lifecycle.js` 中 `ctx.provide('studyRuntime', api)`；通过 `forLibrary(path).invoke(domain, operation, args)`调用。
- `docs/course-outline.zh-CN.md`、`lib/course-outline-book.js`、`lib/contexts/generation/outline/`：从资料提取知识条目 → 按主题归纳 → 章/节/知识点三级总纲 → 原始来源引用、覆盖核验。记录 `courseOutline.nodes`、每个叶子的 `anchors` 和 `supersedes`。大纲由原文条目支持，而非仅根据文件名想象。
- `lib/skeleton.js`：知识骨架 `nodes`（术语、意义、属性、父级、题卡）和 `relations`。确切关系类型 `part-of/causes/contrasts/prerequisite/example-of/related`；单骨架最多 80 节点、160 关系，检查未知端点和不支持的类型。
- `docs/uml-canvas.md`、`ui/SkeletonCanvas.jsx`、`ui/skeleton-diagrams.js`：Class UML、Sequence UML，局部聚焦、搜索、缩放、布局、迷你图；这是可视化**阅读器**，不是关系图协同编辑器。
- `docs/study-workflows.zh-CN.md`：当前流程以题组、练习、AI 带学、FSRS-6 为中心。**“拟议：系统学习”明确未实现**，不可算成已经有逐核心知识点的证据验收。
- `docs/architecture.md` 存储：`study-workspace.json` manifest + hash shard，按域写入、跨域事务、迁移与备份；本地材料支持原文修订与引用验证。对于我们的 P1 资料/题库/RAG 层具有很高参考价值。

已具备：资料解析/引用、总纲、知识骨架、可视化阅读、题目生成与审核、FSRS-6 复习、学习记录。
缺口：总纲不能直接人工改写；课程学习顺序并未全部以新总纲为主；学科级概念图、生成图与手动编辑白板不自动同步；Heptabase 风格每 Part 审批的完整 Tutor 流程不等于当前 StudioHub 学习工作流。
验证边界：总纲文档自述已用合成资料和假模型核验部分流程，真实课程中生成内容质量尚未系统验证。

## 3. LookatStudy DSH Plugin

仓库：https://github.com/Kaiji-Z/dsh-plugin-lookatstudy
重点源码/文档：
- `src/index.ts`：`ctx.tools`、`ctx.systemPrompt.section/context`、`webServer`/Dashboard、插件激活状态；在没有 WebServer 的环境仍可使用工具。
- `src/state.ts`：`LearningState(version:2)`，Course→Section→Lesson；`LessonState` 包含 `ConceptDef[]`、`conceptMastery`、总 mastery、SM-2 复习状态、friction、notes、pending proposals、progress；多个 DSH Session 可绑定到 LessonThreadGroup；数据保存到插件自己的 JSON 文件。
- `src/vendor/bkt.ts`：BKT 四参数（预设），逐概念更新 P(known)；课程完成和弱项有阈值，但概率非经真实样本校准的测量值。
- `src/vendor/sm2.ts`：SM-2 复习，**不是 FSRS-6**；若采用 StudyHub 的 FSRS 需避免重复排期。
- `src/client/maprail.tsx`：课程树、状态条、弱项、到期标记；`src/client/diagrams.ts` 生成课程 Lesson 中心与概念辐射的**星型图**，不是本体论语义关系网络。布局由 `vendor/cmap-elk-layout.ts` 执行。
- `src/tools.ts`：约 31 个 `study_*` 工具，导入 Markdown/本地目录/GitHub/网页等、知识组件定义、记录回答、评估、笔记、复习、导出；`src/client/panel.tsx` 三栏学习工作台。

已具备：教学交互、KC 知识状态、课程门禁、BKT、SM-2、笔记、课时级概念星图、独立 UI。
缺口：模型判定的掌握度仍需校准；知识图不是带已验证语义类型的跨课关系图；独立 `state.json` 与 StudyHub 的 source/course/attempt 没有天然一致性，无法仅靠装两个插件整合。

## 4. dsh-whiteboard

仓库：https://github.com/Fantasy421/dsh-whiteboard
重点源码/文档：
- `src/index.mjs`：注册 `whiteboard_list`、`whiteboard_manage`、`whiteboard_read`、`whiteboard_patch` 四个 DSH 工具；工具以 `exec.agent.session.id` 作为唯一所属 Session。
- `docs/ai-tools.md`：目录版本与场景版本分开；`list → manage(如需要) → read → patch({boardId,baseRevision,operations})`；patch 支持增量 `add/update/delete`，每批最多 100 操作，禁止不读前态就重复提交；可处理节点、文字和箭头。
- `src/model.mjs`、`src/workspace.mjs`：Excalidraw Scene、对象 ID、约束验证、墓碑；前者最多 2000 元素/8 MB，后者每 Session 最多 100 个活跃白板。
- `docs/data-and-safety.md`：CAS + 对象级三方合并，冲突需重新读取；没有跨进程文件锁或真正 CRDT，也没有多人实时协同；完整 GUI 实机验收清单中存在未通过核验的路径。

已具备：可编辑图形白板、AI 写入工具、版本控制、同会话多白板、本地保存、导出。
缺口：存储归属按 Session，不是课程级；图形箭头没有 `prerequisite/contrasts/...` 等语义关系的权威映射；多个 Lesson Session 不能天然共享同一张可编辑白板。需要我们自己的知识图谱和 CanvasProjection/Bridge。

## 5. 与 Heptabase 的能力对照

| 功能 | Heptabase 基准 | StudyHub | LookatStudy | Whiteboard | Oh My 目标 |
|---|---|---|---|---|---|
| Goal Discovery | 已展示 | 部分（课程设置） | 部分（导入设计） | 无 | P0 |
| 多 Course / Goal | 已展示 | 课程集合 | 课程集合 | 无 | P0 |
| Syllabus 生成和人审 | 已展示 | 有总纲，编辑受限 | 导入/设计流程 | 无 | P0 |
| 课程 Mind Map | 我方增强需求 | 有结构与视觉能力 | 课程树 | 不生成 | P0 投影、P1 互动 |
| 带类型 KG | 我方增强需求 | 有知识骨架/关系类型 | 课时星型图 | 只有形状 | P0 领域表、P1 UI |
| 可编辑关系白板 | 部分展示/知识管理 | 只读 UML 视图 | 课时黑板 | 有图形编辑 | P1 自动同步 |
| Lesson Plan | 已展示 | 学法/AI 带学，非同一阶段合同 | 课程导学 | 无 | P0 |
| Teaching Part | 已展示 | 有带学/讲解 | 有强交互 | 可画图 | P0 |
| Review | 已展示 | 题目和 FSRS | 问答/BKT/SM2 | 无 | P0 |
| Notes + Resume | 已展示 | 资料/记录 | 笔记/状态 | 画布 | P0/P1 |
| 学习证据验收 | 不能据功能推定完成 | 系统学习设计未实现 | BKT 初步实现 | 无 | P1/P2 |
| 可配置第三方模型 | Heptabase 取决于订阅/模式 | DSH 模型 | DSH 模型 | DSH 工具 | DSH 模型 |

## 6. 复用边界与版权

三个项目各有公开源码和许可证声明，但仍应锁版本，并检查复制的具体子模块、资源和依赖是否有独立许可证。推荐**接口级复用**而非直接拼接三个状态文件；可以借鉴思想，独立设计统一的数据契约。`hepta-mirror` 声称含反向获取的提示词，不能把其未授权文本直接作为我们仓库的发布内容。
