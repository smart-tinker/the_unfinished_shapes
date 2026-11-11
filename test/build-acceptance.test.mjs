import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertBuildAcceptance } from '../tools/build-acceptance.mjs';
const design={objectType:'block',position:{x:3,y:1,z:4},size:{x:2,y:2,z:2},color:'#3366cc'};
function fixture() {
 const object={id:'object-1',type:'block',ownerId:'builder',position:structuredClone(design.position),size:structuredClone(design.size),color:design.color};
 const previewId='preview-1';
 return {design:structuredClone(design),ownerId:'builder',events:[
  {name:'world_state',arguments:{},success:true},
  {name:'world_preview',arguments:{objects:[structuredClone(design)]},success:true,value:{previewId,objects:[structuredClone(design)]}},
  {name:'world_apply',arguments:{previewId},success:true,value:{revision:1,objects:[structuredClone(object)]}},
 ],state:{revision:1,objects:[object]}};
}
test('a preview is applied once and the server-persisted object matches the requested design',()=>{
 assert.deepEqual(assertBuildAcceptance(fixture()),{constructionCalls:1,persistedObjects:1});
});
test('missing or altered design, mismatched preview, and unexpected tools fail',()=>{
 for(const mutate of [
  input=>{delete input.events[1].arguments.objects[0].color;},
  input=>{input.events[1].arguments.objects[0].color='#abcdef';},
  input=>{input.events[2].arguments.previewId='other';},
  input=>{input.events[2].name='world_command';},
  input=>{input.events.push({name:'world_apply',success:true,arguments:{previewId:'preview-1'}});},
 ]) {const input=fixture();mutate(input);assert.throws(()=>assertBuildAcceptance(input));}
});
test('failed preview or apply, missing persisted object, and unexpected persisted fields fail',()=>{
 for(const mutate of [
  input=>{input.events[1].success=false;},
  input=>{input.events[2].success=false;},
  input=>{input.state.objects=[];},
  input=>{input.state.objects[0].ownerId='other';},
  input=>{input.state.objects[0].size.x=9;},
  input=>{input.events[2].value.objects[0].color='#abcdef';},
 ]) {const input=fixture();mutate(input);assert.throws(()=>assertBuildAcceptance(input));}
});
test('read-only calls are allowed but cannot replace the required preview and Apply',()=>{
 const input=fixture();input.events.unshift({name:'world_state',success:true});assert.deepEqual(assertBuildAcceptance(input),{constructionCalls:1,persistedObjects:1});
 const onlyRead=fixture();onlyRead.events=[{name:'world_state',success:true}];assert.throws(()=>assertBuildAcceptance(onlyRead));
});
