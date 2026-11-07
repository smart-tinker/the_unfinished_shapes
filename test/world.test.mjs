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
