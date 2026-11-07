import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyWorld,applyCommand,validateWorld} from '../src/world.mjs';
const builder={id:'alice',role:'builder'};
const build={type:'build',objectType:'block',position:{x:0,y:1,z:0}};
test('build is immutable and ownership is server-derived',()=>{
 const original=emptyWorld(); const {state,result}=applyCommand(original,builder,{...build,ownerId:'bob'});
 assert.equal(original.objects.length,0); assert.equal(state.objects[0].ownerId,'alice'); assert.equal(result.revision,1); validateWorld(state);
});
test('permissions and unknown mechanics fail closed',()=>{
 assert.throws(()=>applyCommand(emptyWorld(),{id:'x',role:'viewer'},build),{code:'forbidden'});
 assert.throws(()=>applyCommand(emptyWorld(),builder,{...build,objectType:'nuclear-port'}),{code:'new_mechanic_required'});
 const {state}=applyCommand(emptyWorld(),builder,build), remove={type:'remove',id:state.objects[0].id};
 assert.throws(()=>applyCommand(state,{id:'bob',role:'builder'},remove),{code:'forbidden'});
 assert.equal(applyCommand(state,{id:'root',role:'admin'},remove).state.objects.length,0);
});
test('vectors, colors and corrupt saved data are rejected',()=>{
 for(const x of [NaN,Infinity,1001,'1']) assert.throws(()=>applyCommand(emptyWorld(),builder,{...build,position:{x,y:0,z:0}}));
 assert.throws(()=>applyCommand(emptyWorld(),builder,{...build,size:{x:0,y:1,z:1}}));
 assert.throws(()=>applyCommand(emptyWorld(),builder,{...build,color:'red<script>'}));
 assert.throws(()=>validateWorld({version:2,revision:0,objects:[],players:[]}));
});
test('move updates only authenticated player',()=>{
 const state=applyCommand(emptyWorld(),builder,{type:'move',id:'bob',position:{x:1,y:2,z:3}}).state;
 assert.deepEqual(state.players,[{id:'alice',position:{x:1,y:2,z:3}}]);
});
test('update changes only supplied fields and preserves object identity',()=>{
 const {state}=applyCommand(emptyWorld(),builder,build), original=state.objects[0];
 const updated=applyCommand(state,builder,{type:'update',id:original.id,position:{x:4,y:2,z:5},size:{x:3,y:4,z:5},color:'#abcdef'});
 assert.equal(updated.result.revision,2);assert.equal(updated.result.object.id,original.id);assert.equal(updated.result.object.ownerId,'alice');assert.equal(updated.result.object.type,'block');
 assert.deepEqual(updated.result.object.position,{x:4,y:2,z:5});assert.deepEqual(updated.result.object.size,{x:3,y:4,z:5});assert.equal(updated.result.object.color,'#abcdef');assert.equal(state.objects[0].color,'#c8a570');
 const partial=applyCommand(updated.state,builder,{type:'update',id:original.id,color:'#123456'});
 assert.deepEqual(partial.result.object.position,updated.result.object.position);assert.deepEqual(partial.result.object.size,updated.result.object.size);validateWorld(partial.state);
});
test('update checks owner, admin, viewer and missing object',()=>{
 const {state}=applyCommand(emptyWorld(),builder,build), command={type:'update',id:state.objects[0].id,color:'#123456'};
 for (const actor of [{id:'bob',role:'builder'},{id:'alice',role:'viewer'}]) assert.throws(()=>applyCommand(state,actor,command),{code:'forbidden'});
 assert.equal(applyCommand(state,{id:'root',role:'admin'},command).result.object.color,'#123456');
 assert.throws(()=>applyCommand(state,builder,{...command,id:'missing'}),{code:'not_found'});
});
test('update rejects invalid or immutable fields without partial mutation',()=>{
 const {state}=applyCommand(emptyWorld(),builder,build), base={type:'update',id:state.objects[0].id};
 for(const patch of [{},{ownerId:'bob'},{objectType:'port'},{color:'red'},{color:null},{size:{x:0,y:1,z:1}},{position:{x:Infinity,y:1,z:1}},{position:null},{position:{x:2,y:3,z:4},color:'invalid'}]) {
   const snapshot=structuredClone(state);assert.throws(()=>applyCommand(state,builder,{...base,...patch}));assert.deepEqual(state,snapshot);
 }
});
test('update preconditions reject stale fields atomically but allow unrelated edits',()=>{
 const {state}=applyCommand(emptyWorld(),builder,build), object=state.objects[0];
 const changed=applyCommand(state,builder,{type:'update',id:object.id,color:'#123456',expected:{color:object.color}}).state;
 assert.throws(()=>applyCommand(changed,builder,{type:'update',id:object.id,color:'#abcdef',position:{x:8,y:2,z:3},expected:{color:object.color,position:object.position}}),{code:'conflict',status:409});
 assert.deepEqual(changed.objects[0].position,object.position);
 const moved=applyCommand(changed,builder,{type:'update',id:object.id,position:{x:8,y:2,z:3},expected:{position:object.position}});
 assert.equal(moved.result.object.color,'#123456');assert.equal(moved.result.object.position.x,8);
 for(const expected of [null,{},[],{size:object.size},{color:object.color,size:object.size}]) assert.throws(()=>applyCommand(state,builder,{type:'update',id:object.id,color:'#abcdef',expected}),{code:'invalid_command'});
});
