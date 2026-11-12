import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, transition, snapshot } from '../src/core.mjs';
import { projectCourse } from '../src/projections.mjs';

function seed() {
  let state = newState();
  const run = (action, payload, actor) => {
    const res = transition(state, action, payload, {now:'2026-11-11T00:00:00.000Z', actor});
    state = res.state; return res.result;
  };
  const goal = run('goal.create', {title:'Understand personalized learning', expectedOutcome:'Design and evaluate an AI Tutor'});
  const course = run('course.create', {goalId:goal.id, title:'Education learning sciences'});
  const plan = run('course.plan', {courseId:course.id, syllabusRevision:0, topics:[{title:'How learning support works', subtopics:[
    {title:'Zone of proximal development', description:'Independent vs assisted performance'},
    {title:'Scaffolding', description:'Temporary tailored help'},
    {title:'Formative assessment', description:'Evidence changes teaching'},
  ]}]});
  const ids = plan.syllabus.topics[0].subtopics.map(x=>x.conceptId);
  run('course.approve',{courseId:course.id, syllabusRevision:plan.syllabus.revision}, 'learner');
  return { get state() { return state; }, run,goal,course,ids,plan };
}

test('course goal -> approved syllabus -> lesson -> review -> note -> finish',()=>{
 const ctx=seed();
 const lesson=ctx.run('lesson.create',{courseId:ctx.course.id,title:'ZPD and scaffolding',parts:[{title:'Core distinction',objective:'Explain ZPD'},{title:'Transfer case',objective:'Design a scaffold'}]});
 assert.equal(lesson.phase,'plan_pending');
 assert.throws(()=>ctx.run('lesson.cover',{lessonId:lesson.id,partIndex:0}),/Wrong teaching/);
 ctx.run('lesson.approve',{lessonId:lesson.id},'learner');
 ctx.run('lesson.partWrite',{lessonId:lesson.id,partIndex:0,body:'ZPD is independent versus supported ability.'});
 ctx.run('lesson.cover',{lessonId:lesson.id,partIndex:0});
 assert.equal(ctx.state.concepts[ctx.ids[0]].mastery,'unverified');
 ctx.run('lesson.partWrite',{lessonId:lesson.id,partIndex:1,body:'In a new case, choose a temporary scaffold.'});
 ctx.run('lesson.cover',{lessonId:lesson.id,partIndex:1});
 const assessment=ctx.run('assessment.record',{lessonId:lesson.id,conceptId:ctx.ids[0],question:'How does ZPD differ from scaffolding?',studentAnswer:'One is a capability gap, one is support.',feedback:'Correct with a transfer example',score:0.95,transfer:true,hintCount:0});
 assert.equal(assessment.provisionalMastery,'demonstrated');
 ctx.run('lesson.reviewEnd',{lessonId:lesson.id});
 assert.throws(()=>ctx.run('lesson.finish',{lessonId:lesson.id}),/Create a lesson note/);
 assert.throws(()=>ctx.run('note.add',{lessonId:lesson.id,title:'x',content:'y',sourceRefs:['file:educational-psychology.md']}),/registered source/);
 const src=ctx.run('source.register',{title:'Educational psychology',uri:'https://example.org/edpsych.pdf',kind:'file'});
 const note=ctx.run('note.add',{lessonId:lesson.id,title:'ZPD insight',content:'ZPD is not a fixed level.',conceptIds:[ctx.ids[0]],sourceRefs:[{sourceId:src.id,locator:'p.17'}]});
 assert.deepEqual(note.sourceRefs,[{sourceId:src.id,locator:'p.17',page:17}]);
 assert.deepEqual(note.conceptIds,[ctx.ids[0]]);
 ctx.run('lesson.finish',{lessonId:lesson.id});
 assert.equal(snapshot(ctx.state,ctx.course.id).lessons[0].phase,'feedback_pending');
 assert.throws(()=>ctx.run('lesson.feedback',{lessonId:lesson.id}),/feedback/);
 ctx.run('lesson.feedback',{lessonId:lesson.id,feedback:'节奏合适，想多看例子',nextPreview:'下一课：形成性评价的反馈循环'});
 assert.equal(snapshot(ctx.state,ctx.course.id).lessons[0].status,'complete');
 assert.equal(snapshot(ctx.state,ctx.course.id).resume.nextPreview.text,'下一课：形成性评价的反馈循环');
 assert.equal(ctx.state.events.length,16);
});

test('skipping review does not imply mastery',()=>{
 const ctx=seed();
 const l=ctx.run('lesson.create',{courseId:ctx.course.id,title:'Introduction',parts:[{title:'ZPD',objective:'Explain ZPD'}]});
 ctx.run('lesson.approve',{lessonId:l.id},'learner');
 ctx.run('lesson.partWrite',{lessonId:l.id,partIndex:0,body:'ZPD lesson content.'});
 ctx.run('lesson.cover',{lessonId:l.id,partIndex:0});
 ctx.run('lesson.reviewEnd',{lessonId:l.id,skipped:true});
 ctx.run('lesson.finish',{lessonId:l.id,skipNotes:true});
 ctx.run('lesson.feedback',{lessonId:l.id,skipped:true});
 assert.equal(ctx.state.lessons[l.id].status,'complete');
 assert.equal(ctx.state.concepts[ctx.ids[0]].mastery,'unverified');
});

test('graph keeps course IDs, and prerequisite cycles are refused',()=>{
 const ctx=seed();
 const rel=ctx.run('relation.propose',{from:ctx.ids[0],to:ctx.ids[1],type:'prerequisite',evidenceRefs:['S1:p17']});
 assert.equal(rel.status,'candidate');
 assert.throws(()=>ctx.run('relation.propose',{from:ctx.ids[1],to:ctx.ids[0],type:'prerequisite'}),/cycle/);
 assert.throws(()=>ctx.run('relation.propose',{from:ctx.ids[0],to:ctx.ids[1],type:'prerequisite'}),/Duplicate relation/);
 const graph=projectCourse(ctx.state,ctx.course.id,'graph');
 assert.equal(graph.nodes.length,3);
 assert.equal(graph.edges.length,1);
 assert.equal(graph.edges[0].status,'candidate');
});

test('syllabus update can preserve stable concept IDs by supplying existing IDs',()=>{
 const ctx=seed();
 const old=ctx.plan.syllabus.topics[0];
 const next=ctx.run('course.plan',{courseId:ctx.course.id,syllabusRevision:1,topics:[{id:old.id,title:'Learning theories (revised)',subtopics:[
   {id:old.subtopics[0].id,title:'ZPD (revised)'},
   {id:old.subtopics[1].id,title:'Scaffolding (revised)'},
 ]}]});
 assert.equal(next.syllabus.topics[0].subtopics[0].conceptId,ctx.ids[0]);
 // course.plan never drops what it did not mention: the third knowledge point is kept, not retired
 assert.equal(ctx.state.concepts[ctx.ids[2]].status,'active');
 assert.deepEqual(next.keptUnmentioned,[old.subtopics[2].id]);
 assert.equal(ctx.state.courses[ctx.course.id].status,'draft');
});

test('mindmap and whiteboard are separate projections of the same concepts',()=>{
 const ctx=seed();
 ctx.run('relation.propose',{from:ctx.ids[0],to:ctx.ids[1],type:'explains'});
 const m=projectCourse(ctx.state,ctx.course.id,'mindmap');
 assert.match(m.mermaid,/Zone of proximal development/);
 const w=projectCourse(ctx.state,ctx.course.id,'whiteboard-seed');
 assert.equal(w.operations.filter(o=>o.type==='rectangle').length,3);
 assert.equal(w.operations.filter(o=>o.type==='arrow').length,1);
 assert.ok(w.warning.includes('whiteboard_read'));
});
