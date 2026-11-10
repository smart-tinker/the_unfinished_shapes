import test from 'node:test';
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
  renderer:{domElement:{getBoundingClientRect:()=>({left:0,top:0,width:100,height:100})}},
  canEditObject:object=>Boolean(object&&(h.context.role==='admin'||(h.context.role==='builder'&&object.ownerId===h.context.meId))),
  camera:{},
  THREE:{BoxHelper:class {constructor(mesh,color){this.mesh=mesh;this.color=color;this.geometry={dispose(){}};this.material={dispose(){}};}}},
 });
 h.run('let movePreview=null,dragCandidate=null;');
 h.load('function selectObject(', 'function renderWorld(');
 h.context.objects=objects;
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

test('group move preview applies one snapped delta and preserves relative positions locally',()=>{
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
