import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonTutorStore } from '../src/store.mjs';

test('state persists after restart and rejects stale CAS',async()=>{
  const tmp=await mkdtemp(join(tmpdir(),'ohmy-tutor-'));
  try {
    const file=join(tmp,'nested','state.json');
    const a=new JsonTutorStore(file);
    const first=await a.mutate('goal.create',{title:'Reasoning',expectedOutcome:'Compare evidence'},0);
    const b=new JsonTutorStore(file);
    const restored=await b.read();
    assert.equal(restored.revision,1);
    assert.equal(restored.goals[first.result.id].title,'Reasoning');
    await assert.rejects(()=>a.mutate('goal.create',{title:'Stale',expectedOutcome:'Wrong'},0),e=>e.code==='conflict');
    const saved=JSON.parse(await readFile(file,'utf8'));
    assert.equal(Object.keys(saved.goals).length,1);
  }finally{await rm(tmp,{recursive:true,force:true});}
});

test('serializes concurrent writes within a process',async()=>{
  const tmp=await mkdtemp(join(tmpdir(),'ohmy-tutor-'));
  try {
    const a=new JsonTutorStore(join(tmp,'state.json'));
    await Promise.all(Array.from({length:8},(_,i)=>a.mutate('goal.create',{title:`Topic ${i}`,expectedOutcome:`Learn topic ${i}`})));
    const data=await a.read();
    assert.equal(data.revision,8);
    assert.equal(Object.keys(data.goals).length,8);
  }finally{await rm(tmp,{recursive:true,force:true});}
});
