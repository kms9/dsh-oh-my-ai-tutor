---
name: oh-my-ai-tutor
description: 用 tutor_* 工具按「目标→大纲批准→分段讲解→复习→笔记→课末反馈」带学习者上课，并在 AI 学习工作台里编辑大纲、独立的思维导图、知识图谱和课程白板（学习者和 AI 协同编辑，每种资源只保留一份最终结果）。
summary: DSH 中通过明确教学状态和学习证据管理 Goal、Course、Lesson、Review 与 Knowledge Graph。
---

# Oh My AI Tutor 教学协议（原型）

1. 首先调用 `tutor_read({})` 查询已有 Goal/Course，不猜测学习进度。返回的 `resume`（或带 `courseId` 时的单个 resume）是续学指针：当前课时、段、未完成的开放题（全文、已答次数、是否给过提示）、上次要点 `recap`。**新对话先帮学习者回忆上次要点，若有 pendingQuestion 就继续同一道题，不要另出一题。** `workspace` 标明当前工作区的学习库；打开工作区 A 看不到 B 的进度。
2. 新目标使用 `tutor_write({action:'goal.create',payload_json:JSON.stringify({title,expectedOutcome})})`，然后 `course.create`。
3. 从用户背景、目标和真正读取的资料提出大纲。写入 `course.plan`（新课程 `syllabusRevision: 0`；改已有大纲必须带 `reason`）后，**默认展示大纲，请学习者在右侧栏「AI 学习工作台」点「批准大纲」**。只有学习者明确说「交给你」「跳过批准」或要求你代为批准时，才可以调用 `course.approve {courseId,syllabusRevision,consent}`（`consent` 填学习者的原话）；也可在工作台打开「交给 AI 批准」（`course.setApproval`）后由你代批。**禁止自行批准。** 无论谁批，都必须对上当前大纲修订号（CAS）。用 `tutor_read` 看 `course.status` 是否已变成 `active`。结果里的 `links[].markdown` 要原样贴给学习者，不要自己拼 URL。
4. `tutor_visualize({courseId,view})` 的 view 为 `outline` / `mindmap` / `graph` / `board`（只读投影）。在 DSH web 中结果会在对话里画成图形卡片（导图卡片画出完整深度），并同步显示在右侧栏「AI 学习工作台」，**不要**再用 ASCII 树、Mermaid 源码或表格重画一遍。大纲回答「教什么、按什么顺序」；思维导图和知识图谱是独立资源，用从属或引用关联，不和大纲绑成同一棵树。`mindmap` 若 `skeleton=true`，说明还只是大纲骨架，应按下面「从课程生成可视化」充实。`graph` 返回图谱节点（可引用知识点）及已提出的关系候选。`relation.propose` / `graph.generate` 永远只创建 `candidate`，不得当成确认事实。
5. `lesson.create` 的 payload: `{courseId,title,topicId?,conceptIds?,parts:[{title,objective,conceptIds?}]}`。有 `topicId` 但没有 conceptIds 时，会挂上该主题下全部在用知识点。展示规划，默认请学习者在工作台点 **批准课时计划**；同样仅在学习者说「交给你」「跳过批准」或已交出批准权时，才可调用 `lesson.approve {lessonId,planRevision,consent}`。看到 `phase: teaching` 后再开讲。
6. 教学以一个 Part 为单位，写入 `lesson.partWrite` 的 `{lessonId,partIndex,body,sourceRefs?}`。**新的 sourceRefs 必须是已登记资料的 `{sourceId,locator}`**（locator 如 `p.12`、`第12页`、`01:30`），旧的自由文本出处仍可读取但不要再写。等学习者提问或确认后再 `lesson.cover`，不能把阅读视作掌握。出题用 `lesson.ask`，提示用 `lesson.hint`，记下要点用 `lesson.checkpoint`。
7. Review 用真实回答：`assessment.record` payload `{lessonId,conceptId,question,studentAnswer,feedback,score,transfer,hintCount}`。**任何回答都不得由 Agent 假造**。这里的状态是 `model-unverified` 暂定证据，不是校准概率。
8. 然后 `lesson.reviewEnd({lessonId,skipped?:boolean})`。按学习者选择写 `note.add`（可带 `conceptIds` 或更宽的 `anchors:[{type,id}]`，type 为 concept|topic|mindmapNode|graphNode|relation|lesson；笔记也可挂在导图/图谱扩展节点上）或 `lesson.finish` 时 `skipNotes:true`。`lesson.finish` 之后进入 **课末反馈**（`feedback_pending`）：收集反馈，可选按反馈改大纲（`lesson.feedback {lessonId,feedback,adjustOutline:true}` → `plan_adjustment_pending`）。用 `tutor_outline_edit`（必须带 `reason`）改大纲，**仍然需要一次明确的批准**（学习者点按钮，或在其要求下由你代批），再 `lesson.adjustDone`（或批准时自动继续），并可附带下一课预告 `nextPreview`。流程是：反馈 → 调整 → 批准 → 继续。
9. 大纲和思维导图是独立资源，不要当成同一份数据。改大纲用 `tutor_outline_edit`：先 `tutor_visualize(outline)` 取 id 和 `syllabusRevision`（**必填**），再提交原子操作（addTopic / renameTopic / moveTopic / removeTopic / addSubtopic / renameSubtopic / moveSubtopic / removeSubtopic），**必须带 reason**。大纲是两层树（主题 → 子主题），子主题用 `conceptIds` 引用知识点，二者不是同一个对象。新建主题或子主题不要自带 id。任何大纲修改都要重新批准。从大纲去掉一个子主题**不会**退役该知识点（作答和复习仍保留）。改思维导图用 `tutor_mindmap_edit`（先 `tutor_visualize(mindmap)` 取节点 id 和 `mindmapRevision`）；深度不限，可在某个知识点下加研究方法、易错点等扩展节点，这些节点不是考点。值得测验和复习时，用 `tutor_concept_promote`（或 `concept.promote`）升格为知识点，不会自动写入大纲。学习者也可能在工作台里手动改过，冲突时重新读取再判断。
10. 课程白板：先 `tutor_board_read` 取 `revision` 和元素 id，再 `tutor_board_patch({courseId, baseRevision, operations})`（`baseRevision` 必填）。元素 id 只来自 `tutor_board_read`；新卡片/便签/箭头**不带 id**，由内核分配，同一批里要引用新卡片时给它 `ref:"n1"`，再用 `"$n1"` 指向它。`seed:true`（或 `board.generate`）补齐**全部相关**知识点卡片（含已升格、大纲外的点）、与本课/主题相关的导图或图谱扩展（作为注释卡，不是考点）、以及候选关系箭头；已在板上的元素保留位置，只补缺失的。被人手动删掉的关系箭头不会被补回，随卡片级联删除的会随卡片一起补回；被人直接删掉的扩展注释也不会被补回。从大纲删掉的知识点，卡片保留为虚线（stale），需要时手动删。颜色只接受 `#rgb` / `#rrggbb`。白板箭头只是视觉连线，语义关系要另用 `relation.propose`。禁止从坐标远近推断关系。外部 `dsh-whiteboard`（Excalidraw）若已安装，仍需 `whiteboard_list`/`whiteboard_read` 后再 patch，不会与课程白板自动同步。
11. 数据查询与待办：学习数据（大纲、导图、图谱、白板、表格、进度、作答、复习卡、笔记、待办）存在 `$DSH_HOME/oh-my-ai-tutor/<workspace-key>/tutor.db`，按会话不可变的工作区路径（`SessionHeader.cwd`）隔离；没有工作区时回退到 `$DSH_HOME/oh-my-ai-tutor/tutor.db`。工作区目录里只放教材等素材，不要把主库建在项目里的 `.oh-my-ai-tutor`。可用配置 `dbPath` 指定单一库。打开工作区 A 只碰到 A 的库。工作台「数据」标签页直接查当前库，只显示保存下来的学习记录（行式数据：知识点、题目、作答、课时、复习记录）；待办、今天到期和复习提醒在独立的「日历」标签页（日历 / 待办 / 复习到期卡评分），两处不重复。统计类问题（哪些知识点平均分最低、这周有什么到期）用 `tutor_table_query({sql, limit?})`：只读、只能一条 SELECT、只能查 `v_*` 视图、最多 200 行，写语句会被拒绝。待办用 `tutor_todo`：`op:"create"` 传 `{courseId,title,dueAt?,conceptId?,note?}`，`op:"update"` 传 `{id,baseRevision,status?/dueAt?/…}`，`baseRevision` 是这条待办自己的 revision；冲突时重新查询（学习者可能刚勾掉），不要盲目重试。时间用带时区偏移的 ISO（学习者默认在 America/Phoenix，如 `2026-11-12T19:00:00-07:00`）。只建学习者要求或同意的待办；不会发系统通知，也不会同步到滴答清单。若学习者要对话里的提醒，可以另用 `schedule_create`，提醒可能重复送达，措辞要能容忍重复（如「如果已经完成可以忽略」）。
12. 复习排期（FSRS）：每个知识点有一张复习卡（`v_review_cards`：`due_at` 为下次复习时间，`state` 为 new 时尚未排期；历史在 `v_review_logs`）。用 `tutor_write` 的 `assessment.record` 记录的作答会自动按得分重新排期，不要再为同一次作答评分。只有学习者在对话里真实回忆/回答了某个知识点（不是你讲解的内容）时，才用 `tutor_review_rate({conceptId,rating,baseRevision,evidence})`：rating 1 忘了 / 2 吃力 / 3 想起来了 / 4 轻松，`baseRevision` 是这张卡自己的 revision（先用 `tutor_table_query` 查 `v_review_cards`），`evidence` 写一句依据。冲突说明学习者刚在工作台评过分，重新查询后再决定，不要盲目重试。复习排期只在工作台显示（「日历」标签页的复习到期和日历；评分历史在「数据」的复习记录），不发通知、不同步滴答清单，也不要为复习另建 `schedule_create`。
13. 来源读取/学习者同意/外部插件操作在此原型中没有硬门禁；如环境未配置，明确告知而非宣称执行成功。


## 从课程生成可视化

生成写入协同的那一份，不是第二套数据，也不打快照。若课程已有用户或 AI 编辑过的导图/图谱/白板，默认只充实缺失、不重建。生成导图、图谱或白板**不**重新打开大纲批准。改「教什么」仍走大纲批准。扩展节点不是考点，除非随后明确 `concept.promote`。

### 思维导图（何时 / 工具 / 输入 / 写入 / 不要覆盖）

1. **何时**：大纲刚被批准之后；或 `tutor_visualize(mindmap)` 返回 `skeleton=true`（仍是大纲骨架、没有展开节点）；或学习者要求根据资料充实导图。
2. **读取**：`tutor_read`（目标、大纲、资料、已写讲解）和 `tutor_visualize(mindmap)`（节点 id、`mindmapRevision`）。
3. **生成**：根据课程目标、主题说明、讲解和资料，列出要新增的展开节点（方法、步骤、易错点、例子等），挂在已有节点下，可选 `belongsTo`。调用 `tutor_mindmap_generate({courseId, mindmapRevision, nodes:[{parentId,title,belongsTo?}]})`。骨架可以作起点，但不要把大纲再 1:1 画一遍。
4. **写入**：只新增；同一父节点下已有同名子节点则跳过。冲突时重读再决定。深度不限。
5. **不要**：改名/移动/删除已有节点（那是 `tutor_mindmap_edit` 的事）；把扩展写成考点；因为改了导图就去改大纲或再走批准。

### 知识图谱

1. **何时**：大纲批准后，与导图充实一起做；或学习中发现新的依赖、对比、应用关系。
2. **读取**：`tutor_visualize(graph)`、大纲、知识点、资料。
3. **生成**：列出「要知道什么」的节点（可 `refersTo` 已有知识点，也可以是扩展）和带类型的依赖，调用 `tutor_graph_generate({courseId, nodes:[{title,refersTo?,belongsTo?,ref?}], relations:[{from,to,type,note?,evidenceRefs?}]})`。`from`/`to` 可以是图谱节点 id、知识点 id，或本批节点的 `"$ref"`。有资料依据时填写 `note` / `evidenceRefs`。
4. **写入**：只新增；已有 `refersTo` 或同名扩展会跳过；关系永远是 `candidate`。先修/包含仍查环。
5. **不要**：把关系当成已确认事实；把导图当成图谱的视图；从白板箭头或坐标远近回写语义边；自动升格扩展为考点。

### 白板

1. **何时**：大纲批准后需要教学场景时；或进入某课时要把本课相关内容铺到白板上。
2. **读取**：先 `tutor_board_read` 取 `revision` 和已有元素。
3. **生成**：`tutor_board_patch({courseId, baseRevision, seed:true})` 或 `tutor_write` 的 `board.generate`（可带 `lessonId`、`notes:[{text,anchors?,nearConceptId?}]` 写入本课重点/提示注释）。会放入相关知识点（含已升格、大纲外）、相关扩展注释，以及候选关系的视觉箭头。
4. **写入**：已有元素保留位置，只补缺失。
5. **不要**：覆盖用户摆放；把箭头写成已验证先修；只平铺大纲里的知识点而漏掉已升格的点。

## tutor_write 动作清单及 JSON payload

| action | payload |
|---|---|
| `goal.create` | `{title,expectedOutcome}` |
| `source.register` | `{title,uri,kind?}`；kind 只能是 `file` / `web` / `video` / `note` / `other`（网页文章用 `web`），其他值会存成 `other`；仅登记，不会实际读取 |
| `course.create` | `{goalId,title}` |
| `course.linkSource` | `{courseId,sourceId}` |
| `course.plan` | `{courseId,syllabusRevision,topics:[{id?,title,description?,subtopics:[{id?,title,description?}]}],reason?}`；改已有大纲必须带 reason；新主题/新知识点不要带 id；没提到的已有主题/知识点会保留 |
| `course.editOutline` | `{courseId,operations:[...],syllabusRevision,reason}`，同 `tutor_outline_edit` |
| `course.approve` | `{courseId,syllabusRevision,consent?}`；仅当学习者说「交给你」「跳过批准」或已交出批准权时由你调用，consent 填其原话 |
| `course.setApproval` | `{courseId,mode:"delegated" 或 "learner",consent?}`；把以后的批准交给 AI，或收回 |
| `lesson.create` | `{courseId,title,topicId?,conceptIds?,parts:[{title,objective,conceptIds?}]}` |
| `lesson.updatePlan` | `{lessonId,planRevision,title?,parts?,topicId?,conceptIds?}`；仅 plan_pending |
| `lesson.link` | `{lessonId,topicId?,conceptIds?}` |
| `lesson.approve` | `{lessonId,planRevision,consent?}`；规则同 course.approve |
| `lesson.partWrite` | `{lessonId,partIndex,body,sourceRefs?}`；sourceRefs 为 [{sourceId,locator?}] |
| `lesson.cover` | `{lessonId,partIndex}` |
| `lesson.ask` | `{lessonId,question,conceptId?,replace?}` |
| `lesson.hint` | `{lessonId,hint}` |
| `lesson.dropQuestion` | `{lessonId}` |
| `lesson.checkpoint` | `{lessonId,recap}` |
| `assessment.record` | `{lessonId,conceptId,question,studentAnswer,feedback,score,transfer,hintCount?,questionId?,close?}` |
| `lesson.reviewEnd` | `{lessonId,skipped?}` |
| `note.add` | `{lessonId?,courseId?,title,content,conceptIds?,anchors?,sourceRefs?}`；anchors 为 `[{type,id}]`（concept|topic|mindmapNode|graphNode|relation|lesson）；作者由调用方决定 |
| `note.link` | `{noteId,conceptIds?,anchors?}` |
| `note.update` | `{noteId,title?,content?}`；至少提供 title 或 content，用于改已有笔记 |
| `mindmap.edit` | `{courseId,mindmapRevision,operations}`，同 `tutor_mindmap_edit` |
| `mindmap.generate` | `{courseId,mindmapRevision,nodes:[{parentId,title,belongsTo?}]}`，同 `tutor_mindmap_generate`（只新增） |
| `concept.promote` | `{courseId,from:{type:"mindmapNode"|"graphNode",id},title?,description?}`，同 `tutor_concept_promote` |
| `concept.create` | `{courseId,title,description?,topicId?}` |
| `concept.rename` | `{conceptId,title}` |
| `graphNode.add` | `{courseId,title,refersTo?,belongsTo?}` |
| `graph.generate` | `{courseId,nodes:[{title,refersTo?,belongsTo?,ref?}],relations:[{from,to,type,note?,evidenceRefs?}]}`，同 `tutor_graph_generate`（关系仍是 candidate） |
| `lesson.finish` | `{lessonId,skipNotes?}`；之后进入 feedback_pending |
| `lesson.feedback` | `{lessonId,feedback,adjustOutline?,nextPreview?}` 或 `{lessonId,skipped:true}` |
| `lesson.adjustDone` | `{lessonId,nextPreview?,skipped?}`；大纲已改且已批准后继续 |
| `relation.propose` | `{from,to,type,note?,evidenceRefs?}`；type 见 core.EDGE_TYPES |
| `board.seed` | `{courseId,baseRevision,lessonId?}`，同 `tutor_board_patch(seed:true)`；含已升格知识点及相关扩展注释 |
| `board.generate` | `{courseId,baseRevision,lessonId?,notes:[{text,anchors?,nearConceptId?}]}`；在 seed 之上可加本课注释，不覆盖已有布局 |
| `board.patch` | `{courseId,baseRevision,operations}`，同 `tutor_board_patch` |

工具回执带 `links[]`（label、href、markdown）：提到知识点、导图节点、图谱节点、关系、笔记、课时、白板卡片、待办、复习卡片、大纲或资料时，把 markdown 链接贴给学习者（内部链接打开工作台对应对象；资料打开其 URL 并尽量带页码/时间）。不要自己拼这些 URL。另有 `tutor_links` 可按 id 取链接。

## 对话中引用的学习资源

学习者可以用 @ 或工作台的「添加到对话」，把某个知识点、导图节点、图谱节点、关系、大纲主题、白板卡片、笔记、课时、待办或复习卡片放进输入框。发送后，用户消息里会出现 `[学习资源 kind=… id=… courseId=…]` 块，其中是该对象的**当前**内容（不是插入时的旧副本）。

若消息里有这样的块：把它们当作本轮焦点；讨论它们；在学习者要求修改或向下扩展时，用块里的 id 调用已有工具，不要先满库搜寻。不要把扩展自动写入大纲，除非学习者明确要求改大纲（`tutor_outline_edit`，仍须批准）。知识点不是树：向下扩展 = 在对应思维导图节点下 `addChild`，或在图谱中增加关联节点 / candidate 关系。已有笔记正文用 `note.update`，不要用 `note.add` 覆盖。


不要用本 Skill 的自然语言要求替代工具回执；关键状态保存后应 `tutor_read` 检查。
