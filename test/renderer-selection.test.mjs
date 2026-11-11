import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { rendererHarness } from './support/renderer-harness.mjs';

function selectionHarness() {
 const h=rendererHarness();
 const objects=[
  {id:'one',type:'block',ownerId:'alice',position:{x:-.5,y:0,z:0},size:{x:1,y:1,z:1}},
  {id:'two',type:'block',ownerId:'bob',position:{x:0,y:0,z:0},size:{x:1,y:1,z:1},occluded:true},
  {id:'outside',type:'block',ownerId:'alice',position:{x:.8,y:.8,z:0},size:{x:1,y:1,z:1}},
  {id:'behind',type:'block',ownerId:'alice',position:{x:0,y:0,z:2},size:{x:1,y:1,z:1}},
 ];
 const objectData=new Map(objects.map(object=>[object.id,object]));
 const meshes=new Map(objects.map(object=>[object.id,{id:object.id}]));
 Object.assign(h.context,{
  selectedId:null,selectedIds:new Set(),selectionBoxes:new Map(),selectionBox:null,
  editing:false,inspectorDirty:false,role:'builder',meId:'alice',objectData,meshes,
  scene:{add(){},remove(){}},window:{confirm:()=>true},clearMovePreview(){},
  refreshSelectionVisuals(){},fillInspector(){},MAX_GROUP_SELECTION:32,
  renderer:{domElement:{dataset:{startX:'0',startY:'0'},getBoundingClientRect:()=>({left:0,top:0,width:100,height:100})}},
  canEditObject:object=>Boolean(object&&(h.context.role==='admin'||(h.context.role==='builder'&&object.ownerId===h.context.meId))),
  camera:{},
  THREE:{BoxHelper:class {constructor(mesh,color){this.mesh=mesh;this.color=color;this.geometry={dispose(){}};this.material={dispose(){}};}}},
 });
 h.run('let movePreview=null,dragCandidate=null;');
 h.load('function selectObject(', 'function renderWorld(');
 h.context.objects=objects;
 h.context.pointerRay=()=>({intersectObjects:()=>[{object:{id:'one'}}]});
 h.context.objectIdForHit=hit=>hit.id;
 h.context.controls={enabled:true};
 h.context.boxSelectMode=false;
 h.load('function finishObjectDrag(', 'function disposeGroup(');
 return h;
}

test('selection uses stable IDs for click, modifier add/remove, and clear',()=>{
 const h=selectionHarness();
 h.run("selectObject('one')");
 h.run("selectObject('two',false,true)");
 assert.deepEqual(JSON.parse(h.run('JSON.stringify([...selectedIds])')),['one','two']);
 assert.equal(h.run('selectedId'),'two');
 h.run("selectObject('one',false,true)");
 assert.deepEqual(JSON.parse(h.run('JSON.stringify([...selectedIds])')),['two']);
 assert.equal(h.run('selectedId'),'two');
 h.run('selectObject(null)');
 assert.deepEqual(JSON.parse(h.run('JSON.stringify([...selectedIds])')),[]);
 assert.equal(h.run('selectedId'),null);
});

test('poll keeps valid selected IDs and drops IDs deleted from the world',()=>{
 const h=selectionHarness();
 h.run("selectObject('one');selectObject('two',false,true)");
 h.run("objectData.delete('one');meshes.delete('one');selectObject(null,true)");
 assert.deepEqual(JSON.parse(h.run('JSON.stringify([...selectedIds])')),['two']);
 assert.equal(h.run('selectedId'),'two');
 h.run('selectObject(null)');
 assert.deepEqual(JSON.parse(h.run('JSON.stringify([...selectedIds])')),[]);
});

test('box selection uses projected object centers and includes occluded objects',()=>{
 const h=selectionHarness();
 h.context.THREE.Vector3=class {
  constructor(x,y,z){this.x=x;this.y=y;this.z=z;}
  project(){return this;}
 };
 h.run('selectObjectsInBox({x:25,y:25},{x:75,y:75},false)');
 assert.deepEqual(JSON.parse(h.run('JSON.stringify([...selectedIds])')),['one','two']);
});

test('group move preview preserves relative positions and remains local until Apply',()=>{
 const h=rendererHarness();
 const first={id:'one',position:{x:0,y:1,z:0}};
 const second={id:'two',position:{x:3,y:1,z:2}};
 const positions={one:{...first.position},two:{...second.position}};
 h.context.positions=positions;
 h.context.ghosts=new Map([
  ['one',{position:{set(x,y,z){Object.assign(positions.one,{x,y,z});}}}],
  ['two',{position:{set(x,y,z){Object.assign(positions.two,{x,y,z});}}}],
 ]);
 h.context.placementPosition=()=>({x:5,y:1,z:3});
 h.context.first=first;h.context.second=second;
 h.element('move-snap-enabled').checked=false;
 h.context.inspectorDirty=false;
 h.load('function setMovePreviewPosition(', 'function refreshMovePreview(');
 h.run("let sends=[];function command(body){sends.push(body)};let movePreview={objectId:'one',object:first,objects:[first,second],ghost:ghosts.get('one'),ghosts,plane:'xz'}");
 h.run("setMovePreviewPosition(movePreview,{point:{x:5,y:1,z:3},surface:null})");
 assert.deepEqual(JSON.parse(h.run('JSON.stringify(positions)')),{one:{x:5,y:1,z:3},two:{x:8,y:1,z:5}});
 assert.deepEqual(JSON.parse(h.run('JSON.stringify(movePreview.changes)')),[
  {id:'one',position:{x:5,y:1,z:3},expectedPosition:{x:0,y:1,z:0}},
  {id:'two',position:{x:8,y:1,z:5},expectedPosition:{x:3,y:1,z:2}},
 ]);
 assert.equal(h.run('sends.length'),0);
});

test('multi-selection marks read-only members and caps selected stable IDs at 32',()=>{
 const h=selectionHarness();
 h.run("selectObject('one');selectObject('two',false,true)");
 assert.equal(h.element('selection-label').textContent,'2 shapes selected · 1 read-only');
 assert.equal(h.run("selectionBoxes.get('two').color"),'#aab7bd');
 assert.equal(h.element('remove').disabled,true);
 for(let i=1;i<=31;i++){
  const object={id:'extra-'+i,type:'block',ownerId:'alice',position:{x:i,y:0,z:0},size:{x:1,y:1,z:1}};
  h.context.objectData.set(object.id,object);h.context.meshes.set(object.id,{id:object.id});
  h.run("selectObject('"+object.id+"',false,true)");
 }
 assert.equal(h.run('selectedIds.size'),32);
 assert.equal(h.run("selectedIds.has('extra-31')"),false);
 assert.match(h.element('selection-label').textContent,/32 shapes selected/);
 assert.match(h.element('group-move-status').textContent,/limited to 32/);
});

test('Apply submits one atomic group command and waits for server confirmation',async()=>{
 const h=rendererHarness();
 h.run(`let movePreview={objects:[{id:'one'},{id:'two'}],changes:[
  {id:'one',position:{x:2,y:1,z:0},expectedPosition:{x:0,y:1,z:0}},
  {id:'two',position:{x:5,y:1,z:2},expectedPosition:{x:3,y:1,z:2}}
 ]},settingsGeneration=0,editing=false,commands=[];
 function clearMovePreview(){movePreview=null}
 async function command(body){commands.push(body);return {objects:body.changes.map(change=>({id:change.id,position:change.position}))}}
 async function request(){throw new Error('Unexpected refresh')}
 function renderWorld(){}
 function feedback(){}
`);
 h.load('async function applyGroupMove()', "$('group-move-apply').addEventListener");
 await h.run('applyGroupMove()');
 assert.equal(h.run('commands.length'),1);
 assert.equal(h.run('commands[0].type'),'move_group');
 assert.equal(h.run('commands[0].changes.length'),2);
 assert.equal(h.element('group-move-status').textContent,'The server confirmed all 2 shapes moved in one update.');
});

test('Apply does not retry when the group outcome is unconfirmed',async()=>{
 const h=rendererHarness();
 h.run(`const oldObjects=[{id:'one',position:{x:0,y:1,z:0}},{id:'two',position:{x:3,y:1,z:2}}];
 let movePreview={objects:oldObjects,changes:[
  {id:'one',position:{x:2,y:1,z:0},expectedPosition:oldObjects[0].position},
  {id:'two',position:{x:5,y:1,z:2},expectedPosition:oldObjects[1].position}
 ]},settingsGeneration=0,editing=false,commands=[];
 function clearMovePreview(){movePreview=null}
 async function command(body){commands.push(body);throw new Error('Object two changed since it was read.')}
 async function request(){return {revision:4,objects:oldObjects}}
 function renderWorld(){}
 function feedback(){}
`);
 h.load('async function applyGroupMove()', "$('group-move-apply').addEventListener");
 await h.run('applyGroupMove()');
 assert.equal(h.run('commands.length'),1);
 assert.match(h.element('group-move-status').textContent,/no retry was sent/i);
});


test('plain click on a selected group member collapses selection to that shape',()=>{
 const h=selectionHarness();
 h.run("selectObject('one');selectObject('two',false,true)");
 h.run("finishObjectDrag({pointerId:1,clientX:0,clientY:0,ctrlKey:false,metaKey:false})");
 assert.deepEqual(JSON.parse(h.run('JSON.stringify([...selectedIds])')),['one']);
 assert.equal(h.run('selectedId'),'one');
});

test('group move preview references only controls present in the renderer document',()=>{
 const html=readFileSync(new URL('../src/index.html',import.meta.url),'utf8');
 const source=readFileSync(new URL('../src/renderer.mjs',import.meta.url),'utf8');
 const start=source.indexOf('function setMovePreviewPosition(');
 const end=source.indexOf('function refreshMovePreview(',start);
 assert.ok(start>=0&&end>start);
 const functionBody=source.slice(start,end);
 const documentIds=new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]));
 for(const [,id] of functionBody.matchAll(/\$\('([^']+)'\)/g)) {
  assert.ok(documentIds.has(id),`missing renderer element #${id}`);
 }
});
