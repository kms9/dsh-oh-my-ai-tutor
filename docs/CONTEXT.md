# 项目上下文与需求演进

> 2026-11-11 整理。该文档是本项目对话中的**需求与决策摘要**，不是聊天记录的逐字副本。未做过真实运行验证的部分明确标为计划或推断。

## 为什么做

目标是在 DeepSeek Harness (DSH) 的 **Web 或 Desktop** 内建设 `dsh-oh-my-ai-tutor`，尽量完成 Heptabase AI Tutor 的系统化学习流程，但保持开源、可控、可替换并且能检查学习效果。不是另造通用 LLM 平台，也不以生成一篇讲义或一次问答冒充完成学习。

用户希望：先明确学习目标和基础，再生成可以审核修改的课程大纲；将同一知识体系表现成**大纲、思维导图、知识关系图谱、知识白板**；按 Lesson/Part 组织真正的互动讲解；通过真实回答评估理解、调整后续教学；保存笔记、进度与长期复习，跨会话接着学。

## 需求演进（本次会话）

1. **Heptabase AI Tutor 研究**：参考官方 [AI Tutor](https://heptabase.com/ai-tutor)、[演示视频](https://www.youtube.com/watch?v=GFiM6hnlkgQ)、[Zenn 实测](https://zenn.dev/hizacra/articles/d4a1369334ce29)、[Substack 实验](https://obsidianacademicnotamaking.substack.com/p/260410-ai-heptabase-ai-tutor)，梳理 Goal → Course/Syllabus → Lesson Plan → Teaching → Review → Lesson Notes → Knowledge Management。
2. **两个 Heptabase 相关库交叉评估**：[heptabase-ai-tutor-skill](https://github.com/togo13duke/heptabase-ai-tutor-skill) 可执行教学规则、Markdown 记录与恢复；[hepta-mirror](https://github.com/MarlinDiary/hepta-mirror) 提供第三方整理的阶段提示词与工具定义。后者不是可运行系统，也不作为可直接复制的授权素材。
3. **确定 DSH 宿主**：[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 具有 Cordis、Agent Skills、Subagents、Session Persistence、MCP、Storage、Client Slots 和 Web/Desktop UI，可扩展为独立教学插件。
4. **筛选 DSH 学习插件**：发现 Aha Tutor、LookatStudy、StudyHub、DshVibeLearning、dsh-anki、dsh-noteboard、dsh-whiteboard 等候选，聚焦 **StudyHub、LookatStudy、dsh-whiteboard** 做源码对照。
5. **新增必须考虑的可视化要求**：不只生成大纲，还要导图、知识关系图谱，以及可编辑白板；这些不能是每次重新生成的互不关联图形，必须由同一组知识点 ID 和关系事实投影。
6. **本地原型 v0.1**：创建与 DSH 脱耦的学习领域内核、三个模型工具入口、导图/图谱/画布种子投影、7 项单元测试，以及离线 HTML 工作台预览。真实 DSH 安装、三个第三方项目联调、完整自动教学流程尚未完成。

## 总体用户旅程

1. 提出 Goal：学习方向、为什么学、现实应用和成功标准。
2. 发现学习者背景：已有知识、可用时间/节奏、先修短板、参考资料。
3. 生成 Course/Syllabus 草案：Topic/Subtopic/KnowledgePoint、先修与引用。用户先审阅、修改、确认，再作为课程基线。
4. 导出 Mind Map：展示层级与学习路径；可点击聚焦对应知识点。
5. 建立 Knowledge Graph：对前置、属于、对比、解释、应用等关系给出**候选**，附来源与审核状态；不允许从白板图形坐标推断关系。
6. Whiteboard：呈现知识点及关系，可由用户和 AI 修改布局、批注和图形。语义变更必须先审核，再写回知识数据。
7. 制定本次 Lesson Plan：基于课程进度与已有回答，提出 2–5 Part 或适应实际需求的分段计划，用户确认后执行。
8. 逐 Part 教学：完整解释「是什么、为什么、机制、边界、示例」，可随时追问、调整速度或插入先修内容；允许普通问答与受控教学流程分开。
9. Review：一问一答、应用题/迁移题、提示阶梯、记录真实回答、评分依据与误区；**covered ≠ mastered**。
10. Lesson Note 与 Resume：总结用户已表现出的能力与尚未确认事项，保存下一步，在下一次 Session 继续。日后引入单一权威 FSRS 或 SM-2 复习调度器。

## 学习科学框架

- **UbD/逆向设计**：从目标能力和可观察证据反推教学活动，避免只有主题目录。
- **支架教学/ZPD**：根据实际表现调整任务与支持，不把 LLM 自评当作精确 ZPD 测量。
- **苏格拉底式提问**：通过问题揭示假设和误解，必要时明确讲解以免陷入无效追问。
- **形成性评价**：评价产生可记录的证据并反馈教学，不用聊得久来推定学会。
- **检索练习、间隔复习、迁移**：需要时间间隔、真实作答及新情境，以区分短时复述与能力掌握。
- **概念图与知识管理**：知识点、关系、原始文献和学习记录可彼此导航，但不是所有视觉连线都有教育语义。

项目对话环境提供过两份理论研究 Markdown 与两份 Canvas。**公开 GitHub 仓库仅保留 `research/user-materials/README.md` 的名称与背景索引，原文未公开提交**（授权与内容审查前保持私有）。Canvas 尚不保证被本原型解析。

## 三个候选仓库的复用定位

| 组件 | 适合复用 | 已确认的重要限制 |
| --- | --- | --- |
| [StudyHub](https://github.com/EricWang1358/dsh-web-studyhub) | 来源资料、页码/引文、资料归纳成知识点、课程总纲、知识骨架、题库、FSRS-6；通过 `studyRuntime` 适配 | `docs/study-workflows.zh-CN.md` 的「拟议：系统学习」未实现；总纲修改受限；`skeleton` 不是可编辑白板 |
| [LookatStudy](https://github.com/Kaiji-Z/dsh-plugin-lookatstudy) | 课程树、Lesson UI、KC、BKT、SM-2、交互学习、弱项可视化；算法和策略可作为独立参考 | 概念图在 `src/client/diagrams.ts` 主要是 Lesson→Concept 星型图；状态独立 `state.json`，不是可直接共享的课程领域服务 |
| [dsh-whiteboard](https://github.com/Fantasy421/dsh-whiteboard) | Excalidraw UI 与四个 `whiteboard_*` 工具、read/diff/patch、CAS、元素 ID 映射 | 按 DSH Session 存储，不是 Course/Knowledge Space；不是知识关系语义存储；跨进程写、多人实时协作未支持 |

详细源代码路径、接口与证据见 [`RESEARCH.md`](RESEARCH.md)、[`RESEARCH_AND_IMPLEMENTATION_FULL.md`](RESEARCH_AND_IMPLEMENTATION_FULL.md) 和 [`SOURCES_INDEX.md`](SOURCES_INDEX.md)。

## 已确定的方案原则

1. `TutorDomain` 是 Goal/Course/Syllabus/KC/Lesson/Assessment/Notes 的唯一业务权威数据层。
2. DSH 负责 Agent、工具、Session、权限、Web/Desktop 框架；与学习目标、业务进度区分。
3. 大纲树和脑图是课程结构的不同视图；知识图谱是有类型、证据与审核状态的独立关系数据；白板只是一张图形与空间布局投影。
4. Studio/LookatStudy/whiteboard 不直接互相双写私有状态，优先通过公开接口与独立适配器，失败可禁用。
5. 审批门禁必须由实际用户执行；不能由 Agent 伪造用户确认、回答或自称掌握。
6. 先跑通真实 DSH Web P0，再做 Desktop、第三方适配、全量自动化、认知测量校准。
7. 采用本地优先与可审计变化，示例代码/文档独立创作，不复制未经授权的第三方逆向提示词。

## 现阶段交付与风险

- 已有：`src/` 独立原型、`docs/PRD.md`、`docs/ARCHITECTURE.md`、`docs/ADAPTERS.md`、`docs/EVAL.md`、`docs/ROADMAP.md`、`examples/` 数据与可打开的 HTML 预览。`npm test` 在 Node v22.16.0 下的 **7/7 测试通过**。
- 尚缺：真实 DSH Web/Desktop 插件安装与 Host/Client 实机验证；Tutor 内容生成器与用户审核硬门禁；StudyHub `studyRuntime` API 联调；基于 Course 的 Whiteboard Bridge；长期复习与模型评分校准。
- 不能声称的内容：产品级学习增益、官方 Heptabase 兼容性、已完成第三方插件合并、未经证实的全面白板同步。
