import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyWorld,applyCommand,validateWorld,mechanics} from '../src/world.mjs';
const builder={id:'alice',role:'builder'};
const build={type:'build',objectType:'block',position:{x:0,y:1,z:0}};
test('build is immutable and ownership is server-derived',()=>{
 const original=emptyWorld(); const {state,result}=applyCommand(original,builder,{...build,ownerId:'bob'});
 assert.equal(original.objects.length,0); assert.equal(state.objects[0].ownerId,'alice'); assert.equal(result.revision,1); validateWorld(state);
});
test('build_group applies a complete approved set in one revision and rejects invalid sets atomically',()=>{
 const objects=[
  {objectType:'block',position:{x:0,y:1,z:0},size:{x:2,y:2,z:2},color:'#123456'},
  {objectType:'stairs',direction:'east',position:{x:8,y:1,z:0},size:{x:8,y:2,z:4},color:'#654321'},
 ];
 const original=emptyWorld();
 const {state,result}=applyCommand(original,builder,{type:'build_group',objects});
 assert.equal(result.revision,1);assert.equal(result.objects.length,2);assert.equal(state.revision,1);
 assert.deepEqual(state.objects.map(object=>object.ownerId),['alice','alice']);
 assert.deepEqual(state.objects.map(object=>object.type),['block','stairs']);
 assert.equal(original.objects.length,0);validateWorld(state);
 const before=structuredClone(state);
 assert.throws(()=>applyCommand(state,builder,{type:'build_group',objects:[objects[0],{...objects[1],direction:'up'}]}),{code:'invalid_direction'});
 assert.deepEqual(state,before);
 assert.throws(()=>applyCommand(state,{id:'viewer',role:'viewer'},{type:'build_group',objects}),{code:'forbidden'});
 assert.deepEqual(state,before);
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
test('move updates only the authenticated player and keeps height server-owned',()=>{
 const state=applyCommand(emptyWorld(),builder,{type:'move',position:{x:.5,y:2,z:.5}}).state;
 assert.deepEqual(state.players,[{id:'alice',position:{x:.5,y:0,z:.5},velocityY:0}]);
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
 for(const patch of [{},{ownerId:'bob'},{objectType:'port'},{color:'red'},{color:null},{size:{x:0,y:1,z:1}},{position:{x:Infinity,y:1,z:1}},{position:null},{position:{x:2,y:3,z:4},color:'invalid'},{blocksMovement:'false'},{supportsPlayer:0}]) {
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
 assert.equal(restored.players[0].position.y,0);
 assert.equal(restored.players[0].velocityY,0);
});

test('physics properties are boolean, editable with preconditions, and persisted in validated state',()=>{
 let world=applyCommand(emptyWorld(),builder,{type:'build',objectType:'block',position:{x:0,y:1,z:0}}).state;
 const object=world.objects[0];
 const changed=applyCommand(world,builder,{type:'update',id:object.id,blocksMovement:false,supportsPlayer:false,expected:{blocksMovement:true,supportsPlayer:true}});
 assert.equal(changed.result.object.blocksMovement,false);
 assert.equal(changed.result.object.supportsPlayer,false);
 assert.equal(validateWorld(changed.state).objects[0].supportsPlayer,false);
 assert.throws(()=>applyCommand(changed.state,builder,{type:'update',id:object.id,blocksMovement:'false',expected:{blocksMovement:false}}),{code:'invalid_command'});
 assert.throws(()=>validateWorld({...changed.state,objects:[{...changed.result.object,blocksMovement:0}]}),{code:'invalid_state'});
});

test('movement follows level ground and ignores arbitrary requested height',()=>{
 const world=move(emptyWorld(),{x:.5,y:99,z:0});
 assert.deepEqual(player(world).position,{x:.5,y:0,z:0});
});

test('a solid object blocks walking and repeated large requests cannot tunnel through it',()=>{
 let world=physicsWorld();
 for(let i=0;i<12;i++) world=move(world,{x:10,y:500,z:0});
 assert.ok(player(world).position.x<1.7,JSON.stringify(player(world).position));
 assert.equal(player(world).position.y,0);
});

test('a solid edge blocks one axis while allowing movement to slide along the other',()=>{
 let world=physicsWorld({position:{x:1,y:1,z:0},size:{x:1,y:2,z:8}});
 world=move(world,{x:2,y:0,z:1});
 assert.ok(player(world).position.x<.2);
 assert.ok(player(world).position.z>.4);
});

test('an object with collision disabled does not impede movement',()=>{
 let world=physicsWorld({blocksMovement:false});
 for(let i=0;i<8;i++) world=move(world,{x:10,y:0,z:0});
 assert.ok(player(world).position.x>4,JSON.stringify(player(world).position));
});

test('solid objects block a jump from passing through their underside',()=>{
 let world=physicsWorld({position:{x:0,y:3,z:0},size:{x:2,y:2,z:2}});
 world=move(world,{x:0,y:0,z:0},true);
 assert.ok(player(world).position.y<=0.38+1e-6,JSON.stringify(player(world)));
 assert.equal(player(world).velocityY,0);
});

test('jumping can land on an enabled top surface but not stand on a disabled one',()=>{
 let supported=physicsWorld();
 supported=move(supported,{x:1.25,y:0,z:0},true);
 supported=move(supported,{x:2.5,y:0,z:0});
 supported=move(supported,{x:2.5,y:0,z:0});
 assert.equal(player(supported).position.y,2);

 let unsupported=physicsWorld({supportsPlayer:false});
 unsupported=move(unsupported,{x:1.25,y:0,z:0},true);
 unsupported=move(unsupported,{x:2.5,y:0,z:0});
 unsupported=move(unsupported,{x:2.5,y:0,z:0});
 unsupported=move(unsupported,{x:2.5,y:0,z:0});
 unsupported=move(unsupported,{x:2.5,y:0,z:0});
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


test('manual and agent movement share a speed cap and stay on the island',()=>{
 const alice={id:'alice',role:'builder'}, bob={id:'bob',role:'builder'};
 const command={type:'move',position:{x:1000,y:99,z:1000}};
 const manual=applyCommand(emptyWorld(),alice,command,.25).state.players[0].position;
 const agent=applyCommand(emptyWorld(),bob,command,.25).state.players[0].position;
 assert.deepEqual(agent,manual);
 assert.ok(Math.hypot(manual.x,manual.z)<=1.25+1e-6,JSON.stringify(manual));

 let world=applyCommand(emptyWorld(),alice,{type:'move',position:{x:0,y:0,z:0}},.25).state;
 for(let i=0;i<50;i++) world=applyCommand(world,alice,command,.25).state;
 assert.ok(player(world).position.x<=23.68+1e-6,JSON.stringify(player(world).position));
 assert.ok(player(world).position.x>23.6,JSON.stringify(player(world).position));
 for(let i=0;i<50;i++) world=applyCommand(world,alice,{type:'move',position:{x:-1000,y:0,z:0}},.25).state;
 assert.ok(player(world).position.x>=-23.68-1e-6,JSON.stringify(player(world).position));
 assert.ok(player(world).position.x< -23.6,JSON.stringify(player(world).position));
});

test('legacy objects and players outside the island remain intact while the player can recover inward',()=>{
 const legacy={version:1,revision:7,
  objects:[{id:'old-remote-object',type:'block',position:{x:500,y:1,z:-400},size:{x:2,y:2,z:2},color:'#c8a570',ownerId:'alice'}],
  players:[{id:'alice',position:{x:31,y:0,z:0},velocityY:0}]};
 let world=validateWorld(legacy);
 assert.deepEqual(world.objects[0].position,{x:500,y:1,z:-400});
 assert.deepEqual(player(world).position,{x:31,y:0,z:0});
 world=applyCommand(world,builder,{type:'move',position:{x:32,y:0,z:0}},.25).state;
 assert.equal(player(world).position.x,31,'outward movement from a legacy position is blocked without teleporting it');
 world=applyCommand(world,builder,{type:'move',position:{x:29.5,y:0,z:0}},.25).state;
 assert.ok(player(world).position.x<31,JSON.stringify(player(world).position));
 assert.ok(player(world).position.x>=29.75-1e-6,JSON.stringify(player(world).position));
 assert.deepEqual(world.objects[0].position,{x:500,y:1,z:-400});
});

test('movement rejects non-numeric, non-finite, and out-of-range coordinates',()=>{
 for(const x of [NaN,Infinity,-Infinity,1001,-1001,'1',null]){
  assert.throws(()=>applyCommand(emptyWorld(),builder,{type:'move',position:{x,y:0,z:0}}));
 }
});


function groupMoveWorld() {
 let state=emptyWorld();
 for(const position of [{x:0,y:1,z:0},{x:4,y:1,z:0},{x:4,y:1,z:3}]) {
  state=applyCommand(state,builder,{type:'build',objectType:'block',position}).state;
 }
 return state;
}
function groupMove(objects,delta={x:2,y:0,z:-1}) {
 return {type:'move_group',changes:objects.map(object=>({
  id:object.id,
  position:{x:object.position.x+delta.x,y:object.position.y+delta.y,z:object.position.z+delta.z},
  expectedPosition:object.position,
 }))};
}
test('group move applies one shared delta in one revision without mutating the input',()=>{
 const state=groupMoveWorld(), before=structuredClone(state), objects=state.objects;
 const moved=applyCommand(state,builder,groupMove(objects));
 assert.equal(moved.result.revision,state.revision+1);
 assert.deepEqual(moved.result.objects.map(object=>object.id),objects.map(object=>object.id));
 assert.deepEqual(moved.result.objects.map(object=>object.position),[
  {x:2,y:1,z:-1},{x:6,y:1,z:-1},{x:6,y:1,z:2},
 ]);
 assert.deepEqual(state,before);
 assert.deepEqual(moved.state.objects.map(object=>object.ownerId),['alice','alice','alice']);
});
test('group move rejects mixed ownership, missing IDs, stale positions, duplicates and oversized groups atomically',()=>{
 const base=groupMoveWorld(), carol={id:'carol',role:'builder'};
 const state=applyCommand(base,carol,{type:'build',objectType:'block',position:{x:8,y:1,z:0}}).state;
 const original=structuredClone(state), foreign=state.objects.at(-1);
 const aliceObjects=base.objects;
 const cases=[
  [groupMove([...aliceObjects.slice(0,1),foreign]),builder,'forbidden'],
  [{type:'move_group',changes:[...groupMove(aliceObjects.slice(0,2)).changes,{...groupMove([aliceObjects[2]]).changes[0],id:'missing'}]},builder,'not_found'],
  [{type:'move_group',changes:[{...groupMove(aliceObjects.slice(0,2)).changes[0],expectedPosition:{x:99,y:1,z:0}},groupMove(aliceObjects.slice(0,2)).changes[1]]},builder,'conflict'],
  [{type:'move_group',changes:[groupMove(aliceObjects.slice(0,2)).changes[0],groupMove(aliceObjects.slice(0,2)).changes[0]]},builder,'invalid_command'],
  [{type:'move_group',changes:[]},builder,'invalid_command'],
  [{type:'move_group',changes:Array.from({length:33},(_,index)=>({id:'shape-'+index,position:{x:0,y:1,z:0},expectedPosition:{x:0,y:1,z:0}}))},builder,'invalid_command'],
  [{...groupMove(aliceObjects.slice(0,2)),unexpected:true},builder,'invalid_command'],
 ];
 for(const [command,actor,code] of cases) {
  const snapshot=structuredClone(original);
  assert.throws(()=>applyCommand(snapshot,actor,command),{code});
  assert.deepEqual(snapshot,original,code);
 }
});


test('stairs and ramps are explicit world mechanics with a saved uphill direction',()=>{
 for(const [objectType,direction] of [['stairs','north'],['ramp','east']]){
  const {state,result}=applyCommand(emptyWorld(),builder,{type:'build',objectType,direction,position:{x:0,y:1,z:0},size:{x:4,y:2,z:8}});
  assert.ok(mechanics.includes(objectType));
  assert.equal(result.object.direction,direction);
  assert.deepEqual({blocksMovement:result.object.blocksMovement,supportsPlayer:result.object.supportsPlayer},{blocksMovement:true,supportsPlayer:true});
  assert.equal(validateWorld(state).objects[0].direction,direction);
 }
});

test('stairs and ramps reject invalid or missing directions and corrupt saved directions',()=>{
 for(const objectType of ['stairs','ramp']){
  for(const direction of [undefined,'up','north-east',null,1]){
   const command={type:'build',objectType,position:{x:0,y:1,z:0},size:{x:4,y:2,z:8}};
   if(direction!==undefined)command.direction=direction;
   assert.throws(()=>applyCommand(emptyWorld(),builder,command),{code:'invalid_direction'});
  }
  const corrupt={version:1,revision:1,objects:[{id:objectType,type:objectType,direction:'up',position:{x:0,y:1,z:0},size:{x:4,y:2,z:8},color:'#c8a570',ownerId:'alice',blocksMovement:true,supportsPlayer:true}],players:[]};
  assert.throws(()=>validateWorld(corrupt),{code:'invalid_state'});
 }
});

test('stairs and ramps reject geometry too steep for shared walking physics',()=>{
 const base={type:'build',position:{x:0,y:1,z:0}};
 assert.throws(()=>applyCommand(emptyWorld(),builder,{...base,objectType:'stairs',direction:'north',size:{x:8,y:2.01,z:4}}),{code:'invalid_shape_dimensions'});
 assert.throws(()=>applyCommand(emptyWorld(),builder,{...base,objectType:'ramp',direction:'north',size:{x:4,y:8.01,z:8}}),{code:'invalid_shape_dimensions'});
});

test('a north-facing ramp carries manual and agent movement up its continuous slope',()=>{
 const ramp={type:'build',objectType:'ramp',direction:'north',position:{x:0,y:1,z:10},size:{x:4,y:2,z:8}};
 const base=applyCommand(emptyWorld(),builder,ramp).state;
 base.players.push({id:'alice',position:{x:0,y:0,z:15},velocityY:0},{id:'bob',position:{x:0,y:0,z:15},velocityY:0});
 let manual=structuredClone(base), agent=structuredClone(base);
 for(let z=13.75;z>=6.25;z-=1.25){
  manual=move(manual,{x:0,y:0,z});
  agent=applyCommand(agent,{id:'bob',role:'builder'},{type:'move',position:{x:0,y:0,z}}).state;
 }
 const manualPlayer=player(manual), agentPlayer=agent.players.find(item=>item.id==='bob');
 assert.ok(manualPlayer.position.y>1.5,JSON.stringify(manualPlayer.position));
 assert.ok(manualPlayer.position.y<=2+1e-6,JSON.stringify(manualPlayer.position));
 assert.deepEqual(agentPlayer.position,manualPlayer.position);
});
test('stairs provide four equal walkable rises toward their saved cardinal direction',()=>{
 const stair={type:'build',objectType:'stairs',direction:'east',position:{x:10,y:1,z:0},size:{x:8,y:2,z:4}};
 let world=applyCommand(emptyWorld(),builder,stair).state;
 world.players.push({id:'alice',position:{x:5,y:0,z:0},velocityY:0});
 const heights=[];
 for(const x of [6.25,7.5,8.5,9.5,10.5,11.5,12.5,13.5]){
  world=move(world,{x,y:0,z:0});
  if([7.5,9.5,11.5,13.5].includes(x))heights.push(player(world).position.y);
 }
 assert.deepEqual(heights,[.5,1,1.5,2]);
});

test('stairs and ramps are walkable in every cardinal direction and ignore client Y',()=>{
 for(const objectType of ['stairs','ramp'])for(const direction of ['north','east','south','west']){
  let world=applyCommand(emptyWorld(),builder,{type:'build',objectType,direction,position:{x:0,y:1,z:0},size:{x:8,y:2,z:8}}).state;
  const start={north:{x:0,z:5},east:{x:-5,z:0},south:{x:0,z:-5},west:{x:5,z:0}}[direction];
  const target={north:{x:0,z:-3.5},east:{x:3.5,z:0},south:{x:0,z:3.5},west:{x:-3.5,z:0}}[direction];
  world.players.push({id:'alice',position:{...start,y:0},velocityY:0});
  for(let i=0;i<10;i++)world=move(world,{...target,y:500});
  assert.ok(player(world).position.y>1.5,objectType+' '+direction+' '+JSON.stringify(player(world).position));
  assert.ok(player(world).position.y<=2+1e-6,objectType+' '+direction+' '+JSON.stringify(player(world).position));
 }
});

test('stairs keep the player below a low ceiling until it is cleared',()=>{
 let world=applyCommand(emptyWorld(),builder,{type:'build',objectType:'stairs',direction:'east',position:{x:10,y:1,z:0},size:{x:8,y:2,z:4}}).state;
 world.objects.push({id:'low-ceiling',type:'block',position:{x:11,y:3.9,z:0},size:{x:2,y:1,z:4},color:'#c8a570',ownerId:'alice',blocksMovement:true,supportsPlayer:true});
 world.players.push({id:'alice',position:{x:5,y:0,z:0},velocityY:0});
 for(const x of [6.25,7.5,8.5,9.5,10.5,11.5,12.01])world=move(world,{x,y:500,z:0});
 const underCeiling=player(world);
 assert.ok(underCeiling.position.x<12,JSON.stringify(underCeiling));
 assert.equal(underCeiling.position.y,1.5,JSON.stringify(underCeiling));
 assert.ok(underCeiling.position.y+1.62<=3.4+1e-6,JSON.stringify(underCeiling));
 world=move(world,{x:12.5,y:500,z:0});
 const beyondCeiling=player(world);
 assert.ok(beyondCeiling.position.x>=12.32,JSON.stringify(beyondCeiling));
 assert.equal(beyondCeiling.position.y,2,JSON.stringify(beyondCeiling));
});

test('stairs require enough run for each tread to be sampled by movement steps',()=>{
 for(const direction of ['north','east','south','west']){
  const size=direction==='east'||direction==='west'?{x:.25,y:2,z:4}:{x:4,y:2,z:.25};
  assert.throws(()=>applyCommand(emptyWorld(),builder,{type:'build',objectType:'stairs',direction,position:{x:0,y:1,z:0},size}),{code:'invalid_shape_dimensions'});
 }
});

test('stair and ramp size edits cannot persist geometry beyond their traversal limits',()=>{
 const cases=[
  {objectType:'stairs',direction:'east',size:{x:8,y:2,z:4},invalidSize:{x:8,y:2.5,z:4}},
  {objectType:'ramp',direction:'north',size:{x:4,y:2,z:8},invalidSize:{x:4,y:2,z:1.5}},
 ];
 for(const item of cases){
  const built=applyCommand(emptyWorld(),builder,{type:'build',objectType:item.objectType,direction:item.direction,position:{x:0,y:1,z:0},size:item.size});
  const before=structuredClone(built.state);
  assert.throws(()=>applyCommand(built.state,builder,{type:'update',id:built.result.object.id,size:item.invalidSize,expected:{size:item.size}}),{code:'invalid_shape_dimensions'});
  assert.deepEqual(built.state,before);
 }
});

test('doors and gates persist an explicit, versioned open state without toggling on retry',()=>{
 const world=emptyWorld();
 const door=applyCommand(world,builder,{type:'build',objectType:'door',position:{x:0,y:1.5,z:0},size:{x:1.5,y:3,z:.25}});
 const gate=applyCommand(door.state,builder,{type:'build',objectType:'gate',position:{x:8,y:1,z:0},size:{x:4,y:2,z:.5}});
 assert.ok(mechanics.includes('door'));assert.ok(mechanics.includes('gate'));
 for(const object of gate.state.objects){
  assert.equal(object.state,'closed');
  assert.equal(object.usePolicy,'owner_admin');
  assert.equal(object.version,0);
  assert.equal(object.blocksMovement,true);
  assert.equal(object.supportsPlayer,false);
 }
 const opened=applyCommand(gate.state,builder,{type:'set_state',id:door.result.object.id,state:'open',expectedVersion:0});
 assert.equal(opened.result.object.state,'open');
 assert.equal(opened.result.object.blocksMovement,false);
 assert.equal(opened.result.object.version,1);
 const retry=applyCommand(opened.state,builder,{type:'set_state',id:door.result.object.id,state:'open',expectedVersion:0});
 assert.equal(retry.result.revision,opened.result.revision);
 assert.equal(retry.result.object.version,1);
 assert.throws(()=>applyCommand(retry.state,builder,{type:'set_state',id:door.result.object.id,state:'closed',expectedVersion:0}),{code:'conflict',status:409});
 const closed=applyCommand(retry.state,builder,{type:'set_state',id:door.result.object.id,state:'closed',expectedVersion:1});
 assert.equal(closed.result.object.blocksMovement,true);
 assert.equal(closed.result.object.version,2);
 validateWorld(closed.state);
});

test('button links one stable target and access settings are owner/admin-controlled',()=>{
 let world=applyCommand(emptyWorld(),builder,{type:'build',objectType:'door',position:{x:2,y:1.5,z:0},size:{x:1.5,y:3,z:.25}}).state;
 const door=world.objects[0];
 world=applyCommand(world,builder,{type:'build',objectType:'button',position:{x:1,y:.25,z:0},size:{x:.5,y:.5,z:.25}}).state;
 const button=world.objects[1];
 assert.deepEqual({targetId:button.targetId,targetState:button.targetState,usePolicy:button.usePolicy,version:button.version},
  {targetId:null,targetState:'open',usePolicy:'owner_admin',version:0});
 world=applyCommand(world,builder,{type:'update',id:door.id,usePolicy:'all_players',expected:{usePolicy:'owner_admin'}}).state;
 const linked=applyCommand(world,builder,{type:'update',id:button.id,targetId:door.id,targetState:'closed',usePolicy:'all_players',
  expected:{targetId:null,targetState:'open',usePolicy:'owner_admin'}});
 assert.equal(linked.result.object.targetId,door.id);
 assert.equal(linked.result.object.targetState,'closed');
 assert.equal(linked.result.object.usePolicy,'all_players');
 assert.equal(linked.result.object.version,1);
 const opened=applyCommand(linked.state,{id:'bob',role:'viewer'},{type:'set_state',id:door.id,state:'open',expectedVersion:1});
 assert.equal(opened.result.object.state,'open');
 assert.equal(opened.result.object.blocksMovement,false);
 assert.throws(()=>applyCommand(linked.state,{id:'bob',role:'viewer'},{type:'update',id:button.id,targetId:'another-door',expected:{targetId:door.id}}),{code:'forbidden'});
 assert.throws(()=>applyCommand(linked.state,builder,{type:'update',id:button.id,targetId:'missing',expected:{targetId:null}}),{code:'invalid_target'});
 validateWorld(linked.state);
});

test('closed doors block player movement and the open state makes the same passage traversable',()=>{
 let world=applyCommand(emptyWorld(),builder,{type:'build',objectType:'door',position:{x:2,y:1.5,z:0},size:{x:.5,y:3,z:.5}}).state;
 world=move(world,{x:0,y:0,z:0});
 for(let i=0;i<3;i++)world=move(world,{x:10,y:0,z:0});
 assert.ok(player(world).position.x<=1.43+1e-6,JSON.stringify(player(world).position));
 const opened=applyCommand(world,builder,{type:'set_state',id:world.objects[0].id,state:'open',expectedVersion:0});
 world=move(opened.state,{x:10,y:0,z:0});
 assert.ok(player(world).position.x>2,JSON.stringify(player(world).position));
});
