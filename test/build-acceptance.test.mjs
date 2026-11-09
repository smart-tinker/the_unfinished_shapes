import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertBuildAcceptance } from '../tools/build-acceptance.mjs';
const design={objectType:'block',position:{x:3,y:1,z:4},size:{x:2,y:2,z:2},color:'#3366cc'};
function fixture(n=1) {
 return {design:structuredClone(design),ownerId:'builder',events:Array.from({length:n},()=>({name:'world_build',arguments:structuredClone(design),success:true})),state:{objects:Array.from({length:n},(_,i)=>({id:`object-${i}`,type:'block',ownerId:'builder',position:structuredClone(design.position),size:structuredClone(design.size),color:design.color}))}};
}
test('one or two genuine valid constructions with matching distinct persisted objects pass',()=>{
 for(const n of [1,2])assert.deepEqual(assertBuildAcceptance(fixture(n)),{constructionCalls:n,persistedObjects:n});
});
test('missing or wrong requested color fails even if server default persisted',()=>{
 for(const missing of [true,false]) {
  const input=fixture();if(missing)delete input.events[0].arguments.color;else input.events[0].arguments.color='#c8a570';
  input.state.objects[0].color='#c8a570';assert.throws(()=>assertBuildAcceptance(input));
 }
});
test('object count mismatch, no-op and no calls fail',()=>{
 for(const [calls,objects] of [[2,1],[1,2],[1,0],[0,0]]) {
  const input=fixture(calls);input.state.objects=fixture(objects).state.objects;assert.throws(()=>assertBuildAcceptance(input));
 }
});
test('move, unknown tools, failed calls and invalid second build fail',()=>{
 for(const name of ['world_command','shell']) {const input=fixture();input.events[0].name=name;assert.throws(()=>assertBuildAcceptance(input));}
 const failed=fixture();failed.events[0].success=false;assert.throws(()=>assertBuildAcceptance(failed));
 const changed=fixture(2);changed.events[1].arguments.position.x=9;assert.throws(()=>assertBuildAcceptance(changed));
});
test('duplicate IDs, wrong owner and each altered persisted design field fail',()=>{
 const repeated=fixture(2);repeated.state.objects[1].id=repeated.state.objects[0].id;assert.throws(()=>assertBuildAcceptance(repeated));
 for(const [key,value] of Object.entries({id:'',ownerId:'other',type:'port',position:{x:0,y:0,z:0},size:{x:1,y:1,z:1},color:'#c8a570'})) {
  const input=fixture(2);input.state.objects[1][key]=value;assert.throws(()=>assertBuildAcceptance(input));
 }
});
test('read-only state calls do not count as construction',()=>{
 const input=fixture();input.events.unshift({name:'world_state',success:true});assert.equal(assertBuildAcceptance(input).constructionCalls,1);
 const onlyRead=fixture(0);onlyRead.events=[{name:'world_state',success:true}];assert.throws(()=>assertBuildAcceptance(onlyRead));
});
