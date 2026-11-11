# 三个插件的适配方案（避免直接双写）

## 适配总原则

- 每个外部插件都是 `Provider`，**不是** Tutor Domain 的权威存储。
- 能通过公开 Cordis service/API 调用就不要直接读写第三方 JSON；尚无公开稳定服务的项目先使用算法或 UI 模式作参考。
- 按版本发现/检查接口；插件缺席时可降级为本地文件和文本教学，不隐式报成功。
- 任何读取写入均带 `courseId`, `knowledgePointId`, `sourceRevision`, `sessionId` 等关联键。

## A. StudyHubAdapter（P1 核心）

能力：`SourceProvider` / `CourseOutlineProvider` / `QuestionBankProvider` / `AssessmentSourceProvider`。

参考：`docs/architecture.md` 中 `studyRuntime` service，运行时的 `forLibrary(root)`、`invoke(domain, op, args)` 和 `capabilities()`；目录和知识图谱对应 `generation.courseOutline.build`、`course.outline`、`skeleton.*`，实际 domain `skeleton.v1` / `generation.v1` / `materials.v1` 需动态检查。

接口草案：

```ts
interface SourceProvider {
  import(input: {filePath?:string; url?:string; courseId:string}): Promise<{documentId:string; revision:string}>;
  getDocument(documentId:string): Promise<{pages:number; revision:string}>;
  read(ref: SourceRef): Promise<{text:string; page?:number; offset?:number; verified:boolean}>;
  findEvidence(query:string, scope:{courseId:string}): Promise<SourceRef[]>;
}
interface CourseOutlineProvider {
  generate(courseId:string, sourceIds:string[]): Promise<{jobId:string}>;
  read(courseId:string): Promise<{nodes:unknown[]; revision:string; sources:SourceRef[]}>;
}
```

实际实现步骤：先检查 `studyRuntime` 存在且已加载 Materials/Skeleton/Generation 所需 context；获取当前 session workspace 与 StudyHub library root；查询 schema；启用读取、总纲生成与原文定位；对接我们的 `SyllabusDraft` 并将其与图谱做稳定 ID 映射。重要：StudyHub 的 `courseOutline` 不可直接人工改写，我们的编辑和批准发生在自己的 Draft 中。

不直接复用：StudyHub 题组顺序作为 Tutor 的唯一教学顺序；其计划文档中未实现的系统学习八步骤；直接复制 `study-workspace.json` 作为本插件 Store。

## B. LookatStudyAdapter（P1 参考，算法可单独替换）

能力候选：`KnowledgeTrackingProvider`, `TutorPersonaProvider`, `ReviewScheduler`, `CourseUIReference`。

- `src/vendor/bkt.ts` 为纯算法参考，默认 BKT 四参数；需要明确版本/出处并通过真实学习数据校准。
- `src/vendor/sm2.ts` 是 SM-2；StudyHub 用 FSRS-6。建议 **一个复习对象只能选择一种算法**，优先在 StudioHub/Anki 中已有可靠记录的一条流上集成。
- `src/client/diagrams.ts` 星型图仅把 Lesson 连接到 KCs；**不是**可以直接调用的本体论关系图服务。
- `src/state.ts` 的 LearningState 含 course、lesson、KC 掌握度、friction、notes、线程组、proposal，具备较好参考价值，但不是第三方可直接写入的跨插件 API。

策略：首轮不直接安装并共享 LookatStudy 的 state.json；独立实现 `LearnerConceptState`，在 P1 接入一套知识追踪算法；如果后续需要兼容 LookatStudy 已有用户，单独做一次性导入与对照报告，**不保持双写**。

## C. CanvasBridge（P0 人工操作，P1 自动同步）

参照 `dsh-whiteboard`: `whiteboard_list`, `whiteboard_manage`, `whiteboard_read`, `whiteboard_patch`。

```ts
interface CanvasBinding {
  courseId: string;
  owningSessionId: string;
  boardId: string;
  boardRevision: number;
  kpToElement: Record<string,string>;
  relationToElement: Record<string,string>;
}
interface CanvasBridge {
  read(binding:CanvasBinding):Promise<{revision:number;elements:unknown[]}>;
  diff(graph:KnowledgeGraph, existing:unknown[]):Promise<WhiteboardOperation[]>;
  apply(binding:CanvasBinding, ops:WhiteboardOperation[], baseRevision:number):Promise<{revision:number}>;
}
```

### 实施顺序

1. 在当前所属 DSH Session 调用 `whiteboard_list({})`，锁定准确 `boardId`。
2. `whiteboard_read({boardId})` 获取当前 `revision`, elements, selectedIds。
3. 与我们保存的 `kpToElement` / `relationToElement` 对比，仅补不存在元素、更新自己负责的字段。
4. `whiteboard_patch({boardId,baseRevision:read.revision,operations})`；每批最多 100 操作。
5. 重新 read 确认回写；revision 改变则更新 Binding。
6. 若 revision conflict，保留当前草稿，重新读图，**重新计算 Diff**；不把旧操作改成新版本号直接重试。

### 关键限制

`whiteboard_*` 工具的 session ID 取自调用它的 Agent Session。因此在别的 Session 不可以通过随意指定 `boardId` 编辑“课程主白板”。P0 只输出 seed；P1 应建立 `CourseBoard` 的课程级存储/展示层或临时采用“同一 Course 使用一个长期 DSH Session”的策略。

`src/model.mjs` 只能识别图形操作，里面箭头不保存我们的 `relation.type` / `relation.status`。语义关系必须保留在 tutor.domain。白板中单纯拖动/连线不能直接写 accepted relation。

## D. FSRS / Anki Provider（二选一）

- 如选择 StudyHub：调用 `study_practice` / `study_workspace` 暴露的 review 流程，跟踪它返回的调度结果，不能自己平行写 dueAt。
- 如选择独立 TS-FSRS / Anki：需要明确题卡 ID、review log、desiredRetention、dueAt、学习者时间区、复习结果归属。
- 不将 BKT 概念掌握状态和 FSRS 记忆稳定性数值混为同一个字段。

## E. 学习状态恢复

- `DSH Session` 保存聊天与工具日志；`TutorDomain` 保存 Goal/Course/Lesson/Review 的业务状态。
- 推荐 `Course -> lesson -> sessionGroup` 映射，`Lesson` 可绑定多次 DSH Session；恢复从 Domain 抓取 active lesson/current Part 和 pending question，避免仅靠聊天记忆猜测。
- 需要至少一次断电/重启恢复、异常重试、会话分叉的端到端实验。
