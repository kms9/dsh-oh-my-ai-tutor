# 开发交接与 P0 清单

## 快速状态

- 当前仓库是 **v0.1.0-prototype**：可执行纯领域内核、DSH Cordis Host 入口、生成示例、预览 HTML。
- 在 2026-11-11 通过 `npm test` 的 7/7 Node 单元测试，演示 `npm run demo` 可输出 `examples/generated/`。
- **尚未**在真实 DSH Web/Desktop 做插件安装、API 权限、视图挂载和其他插件适配的 E2E 测试。
- 不可直接宣称掌握率精确、Tutor 提升学习效果或学习 UI 已上线。

## 推荐开始方式

```bash
npm test
npm run demo
# 直接用浏览器打开 examples/tutor-workbench-preview.html 进行离线交互审阅
```

DSH 真实安装前先检查 DSH 版本对 Node 的最低要求。Host 插件入口在 `src/index.mjs`，预览 HTML 是**静态独立演示**，不是 DSH Client 插件。

## P0 工作分解与验收门禁

| 顺序 | Workstream | 交付 | 验收 |
| --- | --- | --- | --- |
| 1 | DSH 宿主集成 | 正常加载 Cordis 插件、Skill 和三个 tool | 真实 Web 新会话能发现工具，关闭学习模式不污染普通对话 |
| 2 | 学习域状态 | Goal/Course/Lesson 强一致存储与持久修订 | 重启/故障不丢状态，CAS 失败不会静默覆盖 |
| 3 | Syllabus/学习者发现 | 教学资料检索、目标、能力目标、大纲草案与显式批准 | 未批准大纲不能进入正式教学；旧知识点 ID 保留 |
| 4 | 学习可视化 | 可切换课程树、思维导图、类型知识图谱 | 三者使用同一 KnowledgePoint ID，候选关系不被误认成有效关系 |
| 5 | Lesson Engine | Lesson Plan、单 Part、问答与用户确认 | 不跳过用户批准，不伪造学员回答 |
| 6 | Assessment/Notes | 一问一答、帮助证据、评分理由、总结笔记 | `covered` 和 `demonstrated` 分开，跳过 Review 为未验证 |
| 7 | Resume/真实场景 | ZPD/支架教学/形成性评价示例 | 中断后换新 Session 仍能接上待回答的题与笔记 |

### P1 候选

- StudyHub SourceProvider：通过 `studyRuntime` 获取来源、页码、quote 及 revision；不能直接读写其 shard。
- Whiteboard Bridge：`CourseId -> BoardId` 的受控绑定。**不要**把不同 DSH Session 的白板直接混为同一份。以 `read/diff/patch/read-back` 验证一致性。
- Learning Evidence/Review Scheduler：必要时单独引入 FSRS，不能与 SM-2 同时给同一道题排两个权威到期时间。
- DSH Client 的课程工作台组件与 Desktop Profile 适配。

## 回归测试最小用例

1. 对同一课程重复生成导图，不重复新增 KnowledgePoint。
2. 修改 Syllabus 节点标题或顺序，保持 KnowledgePoint ID 和答题历史。
3. `prerequisite` 环、无效端点、无证据的确认关系被拒绝或保留为待审核。
4. 不同 Session 切换 Course 不能污染其他课程白板。
5. Agent 自行尝试调用 `approve` 不能替代真实用户批准。
6. 跳过 Review，理解状态仍为 `unverified`；复述生成答案不自动算掌握。
7. 白板冲突后不在旧版本基础上重试，先读取并合并。
8. 从保存的未完成问题恢复后，回答次数和提示状态不丢失。

## 可追溯索引

- 背景：[`CONTEXT.md`](CONTEXT.md)
- 源码研究和出处：[`SOURCES_INDEX.md`](SOURCES_INDEX.md)、[`RESEARCH.md`](RESEARCH.md)
- 完整实施方案：[`RESEARCH_AND_IMPLEMENTATION_FULL.md`](RESEARCH_AND_IMPLEMENTATION_FULL.md)
- 目标产品：[`PRD.md`](PRD.md)
- 领域契约和存储：[`ARCHITECTURE.md`](ARCHITECTURE.md)
- 三方插件适配：[`ADAPTERS.md`](ADAPTERS.md)
- 测试口径：[`EVAL.md`](EVAL.md)
- 工作流与阶段：[`ROADMAP.md`](ROADMAP.md)
