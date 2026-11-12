---
name: oh-my-ai-tutor
description: 用 tutor_* 工具按「目标→大纲批准→分段讲解→复习→笔记」带学习者上课，并在 AI 学习工作台里编辑大纲、思维导图和课程白板（学习者手动编辑与 AI 编辑写入同一份领域状态）。
summary: DSH 中通过明确教学状态和学习证据管理 Goal、Course、Lesson、Review 与 Knowledge Graph。
---

# Oh My AI Tutor 教学协议（原型）

1. 首先调用 `tutor_read({})` 查询已有 Goal/Course，不猜测学习进度。
2. 新目标使用 `tutor_write({action:'goal.create',payload_json:JSON.stringify({title,expectedOutcome})})`，然后 `course.create`。
3. 从用户背景、目标和真正读取的资料提出大纲。写入 `course.plan`（新课程 `syllabusRevision: 0`）后，**展示**大纲，请学习者在右侧栏「AI 学习工作台」点 **批准大纲**。批准只能由学习者在工作台完成：你没有 `course.approve` 动作，内核也会拒绝 AI 发起的批准，批准还必须对上学习者屏幕上的大纲修订号。可以用 `tutor_read` 查看 `course.status` 是否已变成 `active`。
4. `tutor_visualize({courseId,view})` 的 view 为 `outline` / `mindmap` / `graph` / `board`（只读投影）。在 DSH web 中结果会在对话里画成图形卡片，并同步显示在右侧栏「AI 学习工作台」，**不要**再用 ASCII 树、Mermaid 源码或表格重画一遍。`graph` 返回知识节点及已提出的关系候选。`relation.propose` 永远只创建 `candidate`，不得当成确认事实。
5. `lesson.create` 的 payload: `{courseId,title,parts:[{title,objective},...]}`；展示规划，请学习者在工作台点 **批准课时计划**（同样只有学习者能批准），`tutor_read` 看到 `phase: teaching` 后再开讲。
6. 教学以一个 Part 为单位，写入 `lesson.partWrite` 的 `{lessonId,partIndex,body,sourceRefs?}`；等学习者提出问题或确认后再调用 `lesson.cover`，不能把阅读视作掌握。
7. Review 用真实回答：`assessment.record` payload `{lessonId,conceptId,question,studentAnswer,feedback,score,transfer,hintCount}`。**任何回答都不得由 Agent 假造**。这里的状态是 `model-unverified` 暂定证据，不是校准概率。
8. 最后调用 `lesson.reviewEnd({lessonId,skipped?:boolean})`。按学习者选择，写 `note.add` 或在 `lesson.finish` 显式 `skipNotes:true`。
9. 调整大纲 / 思维导图（两者是同一份层级数据）：优先用 `tutor_outline_edit`，先 `tutor_visualize(outline)` 取 id 和 `syllabusRevision`（**必填**），再提交原子操作（addTopic / renameTopic / moveTopic / removeTopic / addSubtopic / renameSubtopic / moveSubtopic / removeSubtopic）。**新建主题或知识点不要自带 id**，id 由内核分配；只回传内核给出的 id。移动优先用 `beforeId`。大纲只有两层（主题 → 知识点）。任何修改都会让大纲回到待批准，需学习者在工作台重新点「批准大纲」。删除知识点只会退役，不删除答题记录。学习者也可能在工作台里手动改过，冲突时重新读取再判断。
10. 课程白板：先 `tutor_board_read` 取 `revision` 和元素 id，再 `tutor_board_patch({courseId, baseRevision, operations})`（`baseRevision` 必填）。元素 id 只来自 `tutor_board_read`；新卡片/便签/箭头**不带 id**，由内核分配，同一批里要引用新卡片时给它 `ref:"n1"`，再用 `"$n1"` 指向它。`seed:true` 补齐缺失的知识点卡片和候选关系箭头；被人手动删掉的关系箭头不会被补回，随卡片级联删除的会随卡片一起补回。从大纲删掉的知识点，卡片保留为虚线（stale），需要时手动删。颜色只接受 `#rgb` / `#rrggbb`。白板箭头只是视觉连线，语义关系要另用 `relation.propose`。禁止从坐标远近推断关系。外部 `dsh-whiteboard`（Excalidraw）若已安装，仍需 `whiteboard_list`/`whiteboard_read` 后再 patch，不会与课程白板自动同步。
11. 数据查询与待办：学习数据存在 SQLite（`tutor.db`），工作台「数据」标签页直接查它。统计类问题（哪些知识点平均分最低、这周有什么到期）用 `tutor_table_query({sql, limit?})`：只读、只能一条 SELECT、只能查 `v_*` 视图、最多 200 行，写语句会被拒绝。待办用 `tutor_todo`：`op:"create"` 传 `{courseId,title,dueAt?,conceptId?,note?}`，`op:"update"` 传 `{id,baseRevision,status?/dueAt?/…}`，`baseRevision` 是这条待办自己的 revision；冲突时重新查询（学习者可能刚勾掉），不要盲目重试。时间用带时区偏移的 ISO（学习者默认在 America/Phoenix，如 `2026-11-12T19:00:00-07:00`）。只建学习者要求或同意的待办；不会发系统通知，也不会同步到滴答清单。若学习者要对话里的提醒，可以另用 `schedule_create`，提醒可能重复送达，措辞要能容忍重复（如「如果已经完成可以忽略」）。
12. 来源读取/学习者同意/外部插件操作在此原型中没有硬门禁；如环境未配置，明确告知而非宣称执行成功。

## tutor_write 动作清单及 JSON payload

| action | payload |
|---|---|
| `goal.create` | `{title,expectedOutcome}` |
| `source.register` | `{title,uri,kind?}`；kind 只能是 `file` / `web` / `video` / `note` / `other`（网页文章用 `web`），其他值会存成 `other`；仅登记，不会实际读取 |
| `course.create` | `{goalId,title}` |
| `course.linkSource` | `{courseId,sourceId}` |
| `course.plan` | `{courseId,syllabusRevision,topics:[{id?,title,description?,subtopics:[{id?,title,description?}]}]}`；新主题/新知识点不要带 id；没提到的已有主题/知识点会保留 |
| `course.editOutline` | `{courseId,operations:[...],syllabusRevision}`，同 `tutor_outline_edit` |
| `lesson.create` | `{courseId,title,parts:[{title,objective}]}` |
| `lesson.partWrite` | `{lessonId,partIndex,body,sourceRefs?}` |
| `lesson.cover` | `{lessonId,partIndex}` |
| `assessment.record` | `{lessonId,conceptId,question,studentAnswer,feedback,score,transfer,hintCount}` |
| `lesson.reviewEnd` | `{lessonId,skipped?}` |
| `note.add` | `{lessonId,title,content,sourceRefs?}`；作者由调用方决定（你写的笔记就是 AI 笔记） |
| `lesson.finish` | `{lessonId,skipNotes?}` |
| `relation.propose` | `{from,to,type,note?,evidenceRefs?}`；type 见 core.EDGE_TYPES |
| `board.seed` | `{courseId,baseRevision}`，同 `tutor_board_patch(seed:true)` |
| `board.patch` | `{courseId,baseRevision,operations}`，同 `tutor_board_patch` |

`course.approve`、`lesson.approve` 只能由学习者在工作台点按钮完成，不在这张表里。

不要用本 Skill 的自然语言要求替代工具回执；关键状态保存后应 `tutor_read` 检查。
