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

function move(world, position, jump = false) {
 return applyCommand(world,builder,{type:'move',position,jump}).state;
}
function physicsWorld({position={x:3,y:1,z:0},size={x:2,y:2,z:2},blocksMovement=true,supportsPlayer=true}={}) {
 let world=applyCommand(emptyWorld(),builder,{type:'build',objectType:'block',position,size}).state;
 const object=world.objects[0];
 if(!blocksMovement||!supportsPlayer) world=applyCommand(world,builder,{type:'update',id:object.id,blocksMovement,supportsPlayer,expected:{blocksMovement:true,supportsPlayer:true}}).state;
 return move(world,{x:0,y:0,z:0});
}
function player(world) { return world.players.find(item=>item.id==='alice'); }

test('each object type stores explicit collision and walkable-top defaults',()=>{
 const expected={block:{blocksMovement:true,supportsPlayer:true},bridge:{blocksMovement:true,supportsPlayer:true},port:{blocksMovement:true,supportsPlayer:true}};
 for(const [objectType,properties] of Object.entries(expected)) {
  const world=applyCommand(emptyWorld(),builder,{type:'build',objectType,position:{x:0,y:1,z:0}}).state;
  assert.deepEqual({blocksMovement:world.objects[0].blocksMovement,supportsPlayer:world.objects[0].supportsPlayer},properties);
 }
});

test('legacy saves gain deterministic physics defaults without losing world data',()=>{
 const legacy={version:1,revision:7,objects:[{id:'old-block',type:'block',position:{x:2,y:1,z:3},size:{x:2,y:2,z:2},color:'#c8a570',ownerId:'alice'}],players:[{id:'alice',position:{x:4,y:1,z:5}}]};
 const restored=validateWorld(legacy);
 assert.equal(restored.objects.length,1);
 assert.equal(restored.objects[0].id,'old-block');
 assert.deepEqual({blocksMovement:restored.objects[0].blocksMovement,supportsPlayer:restored.objects[0].supportsPlayer},{blocksMovement:true,supportsPlayer:true});
 assert.equal(restored.players[0].id,'alice');
 assert.equal(restored.players[0].velocityY,0);
});

test('physics properties are boolean, editable with preconditions, and persisted in validated state',()=>{
 let world=applyCommand(emptyWorld(),builder,{type:'build',objectType:'block',position:{x:0,y:1,z:0}}).state;
 const object=world.objects[0];
 const changed=applyCommand(world,builder,{type:'update',id:object.id,blocksMovement:false,supportsPlayer:false,expected:{blocksMovement:true,supportsPlayer:true}});
 assert.equal(changed.result.object.blocksMovement,false);
 assert.equal(changed.result.object.supportsPlayer,false);
 assert.equal(validateWorld(changed.state).objects[0].supportsPlayer,false);
 assert.throws(()=>applyCommand(changed.state,builder,{type:'update',id:object.id,blocksMovement:'false',expected:{blocksMovement:false}}),{code:'invalid_state'});
 assert.throws(()=>validateWorld({...changed.state,objects:[{...changed.result.object,blocksMovement:0}]}),{code:'invalid_state'});
});

test('movement follows level ground and ignores arbitrary requested height',()=>{
 const world=move(emptyWorld(),{x:.5,y:99,z:0});
 assert.deepEqual(player(world).position,{x:.5,y:0,z:0});
});

test('a solid object blocks walking and repeated large requests cannot tunnel through it',()=>{
 let world=physicsWorld();
 for(let i=0;i<12;i++) world=move(world,{x:10,y:500,z:0});
 assert.ok(player(world).position.x<=1.66,JSON.stringify(player(world).position));
 assert.equal(player(world).position.y,0);
});

test('a solid edge blocks one axis while allowing movement to slide along the other',()=>{
 let world=physicsWorld({position:{x:1,y:1,z:0},size:{x:1,y:2,z:8}});
 world=move(world,{x:2,y:0,z:1});
 assert.ok(player(world).position.x<.1);
 assert.ok(player(world).position.z>.4);
});

test('an object with collision disabled does not impede movement',()=>{
 let world=physicsWorld({blocksMovement:false});
 for(let i=0;i<8;i++) world=move(world,{x:10,y:0,z:0});
 assert.ok(player(world).position.x>4,JSON.stringify(player(world).position));
});

test('jumping can land on an enabled top surface but not stand on a disabled one',()=>{
 let supported=physicsWorld();
 supported=move(supported,{x:1.25,y:0,z:0},true);
 supported=move(supported,{x:2.5,y:0,z:0});
 supported=move(supported,{x:3.75,y:0,z:0});
 assert.equal(player(supported).position.y,2);

 let unsupported=physicsWorld({supportsPlayer:false});
 unsupported=move(unsupported,{x:1.25,y:0,z:0},true);
 unsupported=move(unsupported,{x:2.5,y:0,z:0});
 unsupported=move(unsupported,{x:3.75,y:0,z:0});
 unsupported=move(unsupported,{x:3.75,y:0,z:0});
 unsupported=move(unsupported,{x:3.75,y:0,z:0});
 assert.equal(player(unsupported).position.y,0);
});

test('jump cannot restart in the air and falling from an edge reaches lower ground',()=>{
 let airborne=move(emptyWorld(),{x:0,y:0,z:0},true);
 const firstHeight=player(airborne).position.y;
 airborne=move(airborne,{x:0,y:100,z:0},true);
 assert.ok(player(airborne).position.y>firstHeight);
 assert.ok(player(airborne).position.y<3.5);

 let platform=physicsWorld({position:{x:0,y:1,z:0},size:{x:2,y:2,z:2}});
 platform=move(platform,{x:0,y:0,z:0},true);
 platform=move(platform,{x:0,y:0,z:0});
 platform=move(platform,{x:0,y:0,z:0});
 assert.equal(player(platform).position.y,2);
 for(let i=0;i<8;i++) platform=move(platform,{x:10,y:0,z:0});
 assert.equal(player(platform).position.y,0);
});
