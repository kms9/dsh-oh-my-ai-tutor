import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { newState, transition } from '../src/core.mjs';
import { projectCourse } from '../src/projections.mjs';
let s=newState();const run=(a,p,actor)=>{const out=transition(s,a,p,{actor});s=out.state;return out.result;};
const goal=run('goal.create',{title:'设计个性化学习系统',expectedOutcome:'能够解释并运用 ZPD、支架教学、形成性评价'});
const course=run('course.create',{goalId:goal.id,title:'教育心理学与智能辅导'});
const plan=run('course.plan',{courseId:course.id,syllabusRevision:0,topics:[{title:'教学决策的心理学基础',subtopics:[{title:'最近发展区 ZPD'},{title:'支架教学'},{title:'形成性评价'}]},{title:'从理论到 AI Tutor',subtopics:[{title:'教学策略选择'},{title:'学习证据与知识追踪'}]}]});
run('course.approve',{courseId:course.id,syllabusRevision:plan.syllabus.revision},'learner'); // the learner clicks 批准大纲 in the workbench
const [zpd,scaffold,assessment]=plan.syllabus.topics[0].subtopics.map(x=>x.conceptId);
run('relation.propose',{from:zpd,to:scaffold,type:'explains',note:'待验证的关系：ZPD 为支架教学提供理论依据'});
run('relation.propose',{from:assessment,to:scaffold,type:'applies',note:'形成性评价结果帮助调整支架'});
const out=join(process.cwd(),'examples','generated');await mkdir(out,{recursive:true});
for(const view of ['outline','mindmap','graph','whiteboard-seed']){
 const value=projectCourse(s,course.id,view);
 await writeFile(join(out,`${view}.json`),JSON.stringify(value,null,2)+'\n');
 if(view==='mindmap') await writeFile(join(out,'mindmap.mmd'),value.mermaid+'\n');
}
console.log(`Demo generated: ${out} (revision=${s.revision}; courseId=${course.id})`);
