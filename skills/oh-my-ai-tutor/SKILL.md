---
name: oh-my-ai-tutor
summary: DSH 中通过明确教学状态和学习证据管理 Goal、Course、Lesson、Review 与 Knowledge Graph。
---

# Oh My AI Tutor 教学协议（原型）

1. 首先调用 `tutor_read({})` 查询已有 Goal/Course，不猜测学习进度。
2. 新目标使用 `tutor_write({action:'goal.create',payload_json:JSON.stringify({title,expectedOutcome})})`，然后 `course.create`。
3. 从用户背景、目标和真正读取的资料提出大纲。写入 `course.plan` 后，**展示**大纲并**等待用户确认**；只有确认后才执行 `course.approve`。
4. `tutor_visualize({courseId,view:'mindmap'})` 导出可视化结构；`graph` 返回知识节点及已提出的关系候选。`relation.propose` 永远只创建 `candidate`，不得当成确认事实。
5. `lesson.create` 的 payload: `{courseId,title,parts:[{title,objective},...]}`；展示规划、等待确认后调用 `lesson.approve`。
6. 教学以一个 Part 为单位，写入 `lesson.partWrite` 的 `{lessonId,partIndex,body,sourceRefs?}`；等学习者提出问题或确认后再调用 `lesson.cover`，不能把阅读视作掌握。
7. Review 用真实回答：`assessment.record` payload `{lessonId,conceptId,question,studentAnswer,feedback,score,transfer,hintCount}`。**任何回答都不得由 Agent 假造**。这里的状态是 `model-unverified` 暂定证据，不是校准概率。
8. 最后调用 `lesson.reviewEnd({lessonId,skipped?:boolean})`。按学习者选择，写 `note.add` 或在 `lesson.finish` 显式 `skipNotes:true`。
9. 任何时候用户要求调整大纲，修改未完成部分；保留 `topic.id`、`subtopic.id` 保持知识点稳定。不重置既有答题记录。
10. 白板：先 `whiteboard_list` / `whiteboard_read` 获取正确 board ID 和版本，再将 `whiteboard-seed` 转为与现有元素比较后的操作；禁止直接重放 add seed，禁止从节点坐标推断关系。白板同步尚未自动实现。
11. 来源读取/学习者同意/外部插件操作在此原型中没有硬门禁；如环境未配置，明确告知而非宣称执行成功。

## tutor_write 动作清单及 JSON payload

| action | payload |
|---|---|
| `goal.create` | `{title,expectedOutcome}` |
| `source.register` | `{title,uri,kind?}`；仅登记，不会实际读取 |
| `course.create` | `{goalId,title}` |
| `course.linkSource` | `{courseId,sourceId}` |
| `course.plan` | `{courseId,topics:[{id?,title,description?,subtopics:[{id?,title,description?}]}]}` |
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

不要用本 Skill 的自然语言要求替代工具回执；关键状态保存后应 `tutor_read` 检查。
