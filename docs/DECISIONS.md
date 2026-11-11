# 已确认的架构决策（ADR 摘要）

| ID | 决策 | 依据 | 可逆条件 |
| --- | --- | --- | --- |
| ADR-001 | DSH 作为 Web/Desktop Agent 宿主 | DSH 已具备 Cordis、Skills、Sessions、Tools、Client Slots | DSH 插件接口长期不稳定且无法封装时评估独立前端 |
| ADR-002 | 独立 `TutorDomain` 是权威业务层 | 现有三个组件各自有 Store，直接双写无法保持一致 | 明确实现统一的 `Learning Domain` 标准服务后可替换 |
| ADR-003 | 大纲、思维导图与关系图谱模型分离 | 树形包含关系不等于教育前置、因果关系 | 不变更，属于长期语义约束 |
| ADR-004 | Whiteboard 仅存空间布局及图形映射，关系变更需审查 | Canvas 位置和箭头不能自动认定为真实知识关系 | 不变更，属于长期数据完整性约束 |
| ADR-005 | StudyHub 优先通过 `studyRuntime` / 公共操作适配 | 源文、页码、题库、课程大纲已有强实现 | Provider API 不稳定则保留可替换解析/引用接口 |
| ADR-006 | LookatStudy 参考交互与算法，不直接复用独立 `state.json` | 原状态与我们的实体 ID 不一致，BKT 未经领域校准 | 可独立调用其算法，保留版本和验证样本 |
| ADR-007 | 优先完成 P0 单用户本地闭环 | 验证真实用户学习过程优先于多 Agent 和复杂基础设施 | 在真实使用出现共享/协作需求后推进 P1 |
| ADR-008 | 覆盖、理解证据和掌握状态独立 | 完成 Lesson 不能推断掌握；跳过 Review 仍未验证 | 不变更，属于教育测量原则 |
| ADR-009 | User approval gate 必须是不可由模型伪造的持久业务决策 | Lesson、Syllabus 修改必须可审计 | P0 后续实现，当前 Prompt 约束不满足硬门禁 |
| ADR-010 | 来源必须指向原始资料并注明是否核验 | 课程大纲和 AI 解释不可冒充学术证据 | 不变更，属于可信度约束 |

完整设计与阶段门禁：[`ARCHITECTURE.md`](ARCHITECTURE.md)、[`ADAPTERS.md`](ADAPTERS.md)、[`ROADMAP.md`](ROADMAP.md)。
