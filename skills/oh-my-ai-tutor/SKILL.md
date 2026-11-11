---
name: oh-my-ai-tutor
description: 用 tutor_* 工具按「目标→大纲批准→分段讲解→复习→笔记」带学习者上课，并在 AI 学习工作台里编辑大纲、思维导图和课程白板（学习者手动编辑与 AI 编辑写入同一份领域状态）。
summary: DSH 中通过明确教学状态和学习证据管理 Goal、Course、Lesson、Review 与 Knowledge Graph。
---

# Oh My AI Tutor 教学协议（原型）

1. 首先调用 `tutor_read({})` 查询已有 Goal/Course，不猜测学习进度。
2. 新目标使用 `tutor_write({action:'goal.create',payload_json:JSON.stringify({title,expectedOutcome})})`，然后 `course.create`。
3. 从用户背景、目标和真正读取的资料提出大纲。写入 `course.plan` 后，**展示**大纲并**等待用户确认**；只有确认后才执行 `course.approve`。
4. `tutor_visualize({courseId,view})` 的 view 为 `outline` / `mindmap` / `graph` / `board` / `whiteboard-seed`。在 DSH web 中结果会在对话里画成图形卡片，并同步显示在右侧栏「AI 学习工作台」，**不要**再用 ASCII 树、Mermaid 源码或表格重画一遍。`graph` 返回知识节点及已提出的关系候选。`relation.propose` 永远只创建 `candidate`，不得当成确认事实。
5. `lesson.create` 的 payload: `{courseId,title,parts:[{title,objective},...]}`；展示规划、等待确认后调用 `lesson.approve`。
6. 教学以一个 Part 为单位，写入 `lesson.partWrite` 的 `{lessonId,partIndex,body,sourceRefs?}`；等学习者提出问题或确认后再调用 `lesson.cover`，不能把阅读视作掌握。
7. Review 用真实回答：`assessment.record` payload `{lessonId,conceptId,question,studentAnswer,feedback,score,transfer,hintCount}`。**任何回答都不得由 Agent 假造**。这里的状态是 `model-unverified` 暂定证据，不是校准概率。
8. 最后调用 `lesson.reviewEnd({lessonId,skipped?:boolean})`。按学习者选择，写 `note.add` 或在 `lesson.finish` 显式 `skipNotes:true`。
9. 调整大纲 / 思维导图（两者是同一份层级数据）：优先用 `tutor_outline_edit`，先 `tutor_visualize(outline)` 取 id 和 `syllabusRevision`，再提交原子操作（addTopic / renameTopic / moveTopic / removeTopic / addSubtopic / renameSubtopic / moveSubtopic / removeSubtopic）。**新建主题或知识点不要自带 id**，id 由内核分配；只回传内核给出的 id。任何修改都会让大纲回到待批准，需学习者重新确认（工作台里有「批准大纲」按钮）。删除知识点只会退役，不删除答题记录。学习者也可能在工作台里手动改过，冲突时重新读取再判断。
10. 课程白板：先 `tutor_board_read` 取 `revision` 和元素 id，再 `tutor_board_patch({courseId, baseRevision, operations})`；`seed:true` 一次性补齐所有知识点卡片和候选关系箭头（幂等）。白板箭头只是视觉连线，语义关系要另用 `relation.propose`。禁止从坐标远近推断关系。外部 `dsh-whiteboard`（Excalidraw）若已安装，仍需 `whiteboard_list`/`whiteboard_read` 后再 patch，不会与课程白板自动同步。
11. 来源读取/学习者同意/外部插件操作在此原型中没有硬门禁；如环境未配置，明确告知而非宣称执行成功。

## tutor_write 动作清单及 JSON payload

| action | payload |
|---|---|
| `goal.create` | `{title,expectedOutcome}` |
| `source.register` | `{title,uri,kind?}`；kind 只能是 `file` / `web` / `video` / `note` / `other`（网页文章用 `web`），其他值会存成 `other`；仅登记，不会实际读取 |
| `course.create` | `{goalId,title}` |
| `course.linkSource` | `{courseId,sourceId}` |
| `course.plan` | `{courseId,topics:[{id?,title,description?,subtopics:[{id?,title,description?}]}]}`；新主题/新知识点不要带 id |
| `course.editOutline` | `{courseId,operations:[...],syllabusRevision?}`，同 `tutor_outline_edit` |
| `course.approve` | `{courseId}`，必须先得到用户明确确认 |
| `lesson.create` | `{courseId,title,parts:[{title,objective}]}` |
| `lesson.approve` | `{lessonId}`，必须先得到用户明确确认 |
| `lesson.partWrite` | `{lessonId,partIndex,body,sourceRefs?}` |
| `lesson.cover` | `{lessonId,partIndex}` |
| `assessment.record` | `{lessonId,conceptId,question,studentAnswer,feedback,score,transfer,hintCount}` |
| `lesson.reviewEnd` | `{lessonId,skipped?}` |
| `note.add` | `{lessonId,title,content,author?,sourceRefs?}` |
| `lesson.finish` | `{lessonId,skipNotes?}` |
| `relation.propose` | `{from,to,type,note?,evidenceRefs?}`；type 见 core.EDGE_TYPES |
| `board.seed` | `{courseId,baseRevision?}`，同 `tutor_board_patch(seed:true)` |
| `board.patch` | `{courseId,baseRevision,operations}`，同 `tutor_board_patch` |

不要用本 Skill 的自然语言要求替代工具回执；关键状态保存后应 `tutor_read` 检查。
