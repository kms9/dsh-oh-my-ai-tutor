# 实施路线：尽量少重做，尽量多复用

## P0 — 独立教学闭环与视图数据（当前原型已部分实现）

任务：
- [x] 本地课程领域模型 Goal/Course/Topic/Subtopic/KC 与 JSON 事务原型。
- [x] Syllabus → MindMap/Graph/Whiteboard seed 的统一投影。
- [x] 教学阶段转换、Part 内容、暂定答题证据、Notes/Resume 的最小状态。
- [x] DSH Cordis Host 插件入口与三个模型工具。
- [x] Node 内核单测。
- [ ] 在真实 DSH Web v0.2.2-rc.1 或兼容版本安装、启动与触发工具，记录环境与测试结果。
- [ ] 用户真实审批 Gate；将工具级 `approve` 换成持久决策记录和审批令牌。
- [ ] 可视化课程树/导图/图谱的 DSH Client UI。
- [ ] Lesson Part/Review 回答 UI；保存待回复问题并跨 Session 恢复。
- [ ] 真实运行一个完整 ZPD 示例课程，记录所有状态、断点和引用缺口。

**P0 Gate**：不安装其他学习插件的情况下，课程目标→大纲→导图/图谱→分段教学→复盘→笔记→断开恢复完整走通，不能由 Agent 伪造用户回答或批准。

## P1 — 资料、白板与复习协同

任务：
- [ ] StudyHub SourceProvider（domain/context schema 探测、documentId/locator/quote/revision），并保存真实引用。
- [ ] `CourseBoard` 持久层或者受控 dsh-whiteboard Adapter（list/read/diff/patch/read-back），避免 Session 绑定问题。
- [ ] 图谱候选关系审核 UI：类型/证据/前置环检查/语义版本。
- [ ] LessonNote/KnowledgePoint 多对多链接，以及用户笔记和生成笔记分离。
- [ ] 二选一复习调度策略（FSRS-6 / SM-2），统一题目 ID 和历史。
- [ ] 将 JSON 文件转为 `ctx.storageDomain` / SQLite，按 Course/Entity 版本 CAS，可靠迁移与备份。
- [ ] Web 和 Desktop 的 UI、Profile、权限、断网、升级与多会话场景验收。

**P1 Gate**：课程上传资料后可引用页码；在不同 Lesson 学习同一 KC 时读到同一个 ID；图谱到白板多次同步幂等；带完整记录的复习可以按期重现。

## P2 — 真正的自适应教学与学习效果验证

任务：
- [ ] 独立 `AssessmentEngine`：题目 Rubric、评分理由、证据质量、模型评测盲区。
- [ ] BKT 或其他学习者模型参数校准；在足够数据前只显示“暂定掌握状态”。
- [ ] 教学策略 Policy：依据误解、前置、提示、转移表现选择下一 Part/题型。
- [ ] 延迟复测与迁移题，前后测/延迟测验证学习增益。
- [ ] 子 Agent SyllabusWriter/LessonWriter/Evaluator/NoteWriter 独立评测，并在 DSH Subagents 上编排。
- [ ] 知识跨课程去重、图谱质量审核和概念修订历史。

**P2 Gate**：连续多次学习中，系统能据学习证据改变路径；真实学习者测试显示出可解释的进步，不把结果归因于单纯对话次数增加。

## 决策建议

- 不直接 Fork 三个完整插件进行合并（各有单独 Store/Session 和 UI，改动面过大）。
- 从 StudyHub 使用公开运行时 API 和来源能力；从 LookatStudy 借鉴强教学模式和独立算法；从 dsh-whiteboard 利用公开工具协议，知识图谱仍由 Tutor Domain 掌握。
- 用户此前提出的高内聚、低耦合要求应落实为领域边界和可替换 Provider，避免超大 `TutorAgent` 文件或一个万能插件。
- 现阶段优先完成 **P0 Gate**，再决定是否抽成 NPM 包/独立子 Agent 服务。
