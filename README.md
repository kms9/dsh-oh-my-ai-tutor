# dsh-oh-my-ai-tutor

**状态：v0.1.0-prototype — 可执行的领域内核 + DSH Host 插件入口，尚非完整产品。**

目标：在 DeepSeek Harness（DSH）Web / Desktop 中实现受 Heptabase AI Tutor 学习流程启发、但独立设计的学习系统：

`Goal → Syllabus → Mind Map → Knowledge Graph → Whiteboard → Lesson Plan → Teaching → Review → Notes → Resume`。

## 当前真正实现的内容

- `Goal`、`Course` 与层级式 `Syllabus` 的建立、调整、确认；稳定 Topic/Subtopic/KnowledgePoint ID。
- Lesson 分段教学的**状态**：制定计划 → 等待确认 → 逐 Part 保存内容和覆盖 → 复盘 → 笔记 → 完成。
- 记录真实学习者答案、模型评价与是否使用提示；区分覆盖状态和**暂定**理解证据。没有经校准的 BKT 或可靠掌握概率。
- 由同一份课程数据导出 `outline`、Mermaid `mindmap`、带类型的 `graph` 和供 `dsh-whiteboard` 初始化使用的 **增量操作建议**。
- 关系候选、引用元数据、前置/包含关系的环检测；所有 AI 新增关系保持 `candidate`。
- JSON 本地存储、原子文件替换、进程内顺序写、可选 revision/CAS 检查；`tutor_read`、`tutor_write`、`tutor_visualize` 三个工具。
- 7 个独立 Node 内核测试（构建时可执行，无外部模型和插件依赖）。

## 尚未实现（不得视为已具备）

- DSH Web/Desktop 原生学习工作台和完整组件交互；DSH **真实安装/启动兼容性尚未在目标环境实测**。
- StudyHub 资料解析与课程数据适配器、LookatStudy 的学习状态适配器、dsh-whiteboard 的自动 read/diff/patch 同步。
- 专业 BKT/IRT、FSRS、间隔重复后台任务、成熟的评估器、跨进程/多人写入协调。
- 强制由真实用户批准的服务端审批令牌：当前 `approve` 只通过工具和 Prompt 约束，尚非不可绕过的硬门禁。
- 真实可用的视觉思维导图编辑器；当前提供结构化 mindmap 数据和 Mermaid 源，需 DSH 渲染组件。

## 目录

- `src/core.mjs`：学习领域模型和阶段转换，严格不依赖 DSH。
- `src/projections.mjs`：同一知识数据 → 大纲/思维导图/知识关系图/白板 seed。
- `src/store.mjs`：本地持久化 POC，**不是最终多进程存储方案**。
- `src/index.mjs`：Cordis Host 插件注册三个工具，引用 `@deepseek-ai/dsh-tools`。
- `src/prompt.mjs`、`skills/oh-my-ai-tutor/SKILL.md`：教学行为与使用协议。
- `docs/RESEARCH.md`：三个项目与 Heptabase 的源码级差异。
- `docs/ARCHITECTURE.md`：目标架构和数据契约。
- `docs/PRD.md`：功能范围、用户旅程、交互、验收。
- `docs/ADAPTERS.md`：StudyHub/LookatStudy/whiteboard 集成细则。
- `docs/EVAL.md`：功能、教学效果与安全评测。
- `docs/ROADMAP.md`：分阶段实现路径及门禁。

## 需求背景、调研与交接入口

这次项目提供了可直接接续开发的上下文资料：

- **需求和决策来源：** [`docs/CONTEXT.md`](docs/CONTEXT.md)（对话中的背景、用户旅程、设计原则）和 [`docs/DECISIONS.md`](docs/DECISIONS.md)（ADR 摘要）。
- **资料检索与源码索引：** [`docs/SOURCES_INDEX.md`](docs/SOURCES_INDEX.md)（Heptabase / DSH / StudyHub / LookatStudy / dsh-whiteboard 的官方链接、文件路径与证据边界）。
- **完整研究：** [`docs/RESEARCH_AND_IMPLEMENTATION_FULL.md`](docs/RESEARCH_AND_IMPLEMENTATION_FULL.md)、[`docs/RESEARCH.md`](docs/RESEARCH.md)。
- **产品与技术方案：** [`docs/PRD.md`](docs/PRD.md)、[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)、[`docs/ADAPTERS.md`](docs/ADAPTERS.md)。
- **里程碑和验收：** [`docs/ROADMAP.md`](docs/ROADMAP.md)、[`docs/EVAL.md`](docs/EVAL.md)、[`docs/HANDOFF.md`](docs/HANDOFF.md)。
- **可视化预览：** [`examples/tutor-workbench-preview.html`](examples/tutor-workbench-preview.html)；独立 HTML 预览，与实际 DSH Client 不同。
- **课程与知识图谱示例：** [`examples/generated/`](examples/generated/) 包含大纲、导图、关系图和白板 seed。
- **用户提供的学习科学资料：** [`research/user-materials/README.md`](research/user-materials/README.md) 保留原始材料的名称、用途和授权说明。**由于当前 GitHub 仓库公开，四份原始 Markdown / Canvas 暂不发布**；它们不影响代码测试和功能原型。

## 本地验证

```bash
npm test
npm run demo
```

当前开发内核已在 Node.js v22.16 下运行测试。**目标 DSH 的最新开发预览要求 Node.js >= 24.9**，实际部署应使用符合 DSH 要求的 Node 版本。

## DSH 插件加载（需要在真实 DSH 环境核验）

仓库声明了 `dsh.bundle.patch` 与 `export const apply(ctx)`，参照 DSH 官方与 `dsh-whiteboard` 插件模板。

```bash
# 在支持 Git 安装的 DSH web profile 中尝试
# 推荐先用本地目录（按本机 DSH 插件管理器可接受的路径安装）
dsh plugin --profile web add ./dsh-oh-my-ai-tutor
# 按宿主提示重启 dsh web
```

Desktop 应通过桌面应用插件管理器导入本目录或打包产物；`web` 和 `desktop` Profile **相互独立**。以上不是已完成的 E2E 安装测试。

## 教学模式与普通对话隔离

为避免安装后把所有 DSH 对话强制变成 AI Tutor，插件**默认不注入全局教学人格**。可以在专用学习环境中显式配置 `enableGlobalTutorPolicy: true`，或在会话内手动加载 `skills/oh-my-ai-tutor/SKILL.md` 的教学协议。更完善的按 Session/课程激活门禁与 `/learn` 入口属于 P0 后续实现。

## 与其他插件如何协作

- StudyHub：只在适配器完成后提供资料、题目和来源能力；其 `studyRuntime` API 需要按安装版本动态发现能力。
- LookatStudy：先借鉴独立的 BKT、SM-2 和课堂 UI 模式；不能直接把它的 `state.json` 当作我们业务数据的权威源。
- dsh-whiteboard：`tutor_visualize(view='whiteboard-seed')` 只返回初始化操作。需要先调用 `whiteboard_list`、`whiteboard_read`，取准 `boardId` 和 `baseRevision`，比较现有元素，再调用 `whiteboard_patch`。
- **任何时候都以本插件稳定 KnowledgePoint ID 与关系表为领域真相，而不以画布位置或可见标签作为关系真相。**

## 用于试验的示例主题

以「理解 ZPD、支架教学和形成性评价并设计 AI 教学策略」为例，`npm run demo` 输出大纲、思维导图、语义关系以及白板 seed 到 `examples/generated/`，不会调用模型。

设计借鉴 Heptabase 的公开产品流程，不复制未经授权的逆向提示词。集成第三方开源代码前请核对对应版本许可证并保留来源说明。

License: MIT（仅本仓库新生成的示例代码与文档）。
