import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {rendererHarness} from './support/renderer-harness.mjs';

test('construction palette exposes stairs, ramps, direction and preview/apply controls',()=>{
 const html=readFileSync(new URL('../src/index.html',import.meta.url),'utf8');
 for(const kind of ['stairs','ramp'])assert.match(html,new RegExp(`data-kind="${kind}"`));
 assert.match(html,/id="build-direction"/);
 assert.match(html,/id="build-preview"/);
 assert.match(html,/id="build-apply"/);
 assert.match(html,/id="build-cancel"/);
});

test('block palette includes wall, floor and column size presets',()=>{
 const html=readFileSync(new URL('../src/index.html',import.meta.url),'utf8');
 for(const preset of ['wall','floor','column'])assert.match(html,new RegExp(`data-preset="${preset}"`));
});

test('every construction palette kind is unique for the packaged client controls',()=>{
 const html=readFileSync(new URL('../src/index.html',import.meta.url),'utf8');
 const kinds=[...html.matchAll(/data-kind="([^"]+)"/g)].map(match=>match[1]);
 assert.equal(new Set(kinds).size,kinds.length);
 for(const kind of ['wall','floor','column'])assert.ok(kinds.includes(kind));
});

test('build preview stays local until Apply and Cancel never sends a command',async()=>{
 class Shape { constructor(){this.points=[];} moveTo(x,y){this.points.push([x,y]);} lineTo(x,y){this.points.push([x,y]);} closePath(){} }
 class ExtrudeGeometry { constructor(shape,options){this.shape=shape;this.options=options;} translate(){return this;} }
 class BoxGeometry { constructor(...dimensions){this.dimensions=dimensions;} }
 class Group {
  constructor(){this.children=[];this.userData={};this.position={set(){}};this.rotation={y:0};}
  add(child){this.children.push(child);}
  traverse(callback){callback(this);for(const child of this.children)callback(child);}
 }
 class Material {
  constructor(options){this.color={value:options.color,set(value){this.value=value;}};this.roughness=options.roughness;}
  clone(){return new Material({color:this.color.value,roughness:this.roughness});}
 }
 class Mesh {
  constructor(geometry,material){this.geometry=geometry;this.material=material;this.userData={};this.position={set(){}};}
 }
 const h=rendererHarness(),commands=[],added=[],removed=[];
 h.context.THREE={Shape,ExtrudeGeometry,BoxGeometry,Group,Mesh,MeshStandardMaterial:Material};
 h.context.SHAPE_DEFAULT_SIZES={stairs:{x:8,y:2,z:4},ramp:{x:4,y:2,z:8}};
 h.context.document.querySelectorAll=()=>[];
 h.context.scene={add(mesh){added.push(mesh);},remove(mesh){removed.push(mesh);}};
 h.context.selectedKind='stairs';h.context.selectedPreset='stairs';h.context.buildPreview=null;
 h.context.settingsGeneration=0;h.context.editing=false;h.context.disposeGroup=()=>{};h.context.feedback=()=>{};
 h.context.command=async body=>{commands.push(structuredClone(body));return {object:{id:'server-shape',...body}};};
 h.load('function objectMesh(object)','function pointerRay(');
 h.load('function clearBuildPreview()','function clearMovePreview()');
 h.load("for (const button of document.querySelectorAll('[data-kind]'))","$('remove').addEventListener('click'");
 h.element('build-x').value='4';h.element('build-z').value='6';h.element('build-direction').value='east';
 await h.element('build-form').listeners.submit({preventDefault(){}});
 assert.equal(commands.length,0,'preview must not mutate the server');
 assert.equal(added.length,1,'preview geometry should appear locally');
 await h.element('build-apply').listeners.click();
 assert.equal(commands.length,1,'Apply sends one build command');
 assert.equal(commands[0].objectType,'stairs');assert.equal(commands[0].direction,'east');
 h.element('build-form').listeners.submit({preventDefault(){}});
 h.element('build-cancel').listeners.click();
 assert.equal(commands.length,1,'Cancel must stay local');
 assert.equal(removed.length,2,'Apply and Cancel each remove their preview');
});

test('canceling an agent preview clears only local ghosts and never calls Apply',async()=>{
 const h=rendererHarness(),removed=[],decisions=[],commands=[];
 h.context.agentBuildPreview=null;h.context.settings={threadId:'thread-1'};h.context.connected=true;h.context.busy=false;
 h.context.scene={add(){},remove(mesh){removed.push(mesh);}};
 h.context.objectMesh=object=>({object,traverse(callback){callback({material:{clone(){return {color:{set(){}},transparent:false,opacity:1,depthWrite:true};}}});}});
 h.context.disposeGroup=()=>{};h.context.feedback=()=>{};h.context.updateChatControls=()=>{};h.context.startActivity=()=>{};
 h.context.command=async(...args)=>commands.push(args);
 h.context.bridge={decideBuildPreview:async(...args)=>decisions.push(args)};
 h.load('function addMessage(text, kind =', 'function updateChatControls()');
 h.load('function clearAgentBuildPreview(', 'function buildDesign()');
 h.run("showAgentBuildPreview({previewId:'preview-2',objects:[{objectType:'block',position:{x:0,y:1,z:0},size:{x:2,y:2,z:2},color:'#123456'}]})");
 const card=h.element('chat').children[0],cancel=card.children.find(node=>/cancel/i.test(node.textContent));
 await cancel.listeners.click();
 assert.deepEqual(decisions,[['preview-2','cancel','thread-1']]);
 assert.equal(removed.length,1);
 assert.equal(commands.length,0);
 assert.equal(h.context.agentBuildPreview,null);
});

test('stairs and ramps render as four-step and continuous profiles in their saved direction',()=>{
 class Shape {
  constructor(){this.points=[];}
  moveTo(x,y){this.points.push([x,y]);}
  lineTo(x,y){this.points.push([x,y]);}
  closePath(){this.closed=true;}
 }
 class ExtrudeGeometry {
  constructor(shape,options){this.shape=shape;this.options=options;}
  translate(){return this;}
 }
 class BoxGeometry {constructor(...dimensions){this.dimensions=dimensions;}}
 class Group {
  constructor(){this.children=[];this.userData={};this.position={set(){}};this.rotation={y:0};}
  add(child){this.children.push(child);}
 }
 class Mesh {
  constructor(geometry,material){this.geometry=geometry;this.material=material;this.userData={};this.position={set(){}};}
 }
 const h=rendererHarness();
 h.context.THREE={Shape,ExtrudeGeometry,BoxGeometry,Group,Mesh,MeshStandardMaterial:class{constructor(options){this.options=options;}}};
 h.load('function objectMesh(object)','function pointerRay(');
 const ramp=h.run(`objectMesh({id:'ramp',type:'ramp',direction:'north',position:{x:0,y:1,z:0},size:{x:4,y:2,z:8},color:'#123456'})`);
 assert.ok(ramp.children[0].geometry instanceof ExtrudeGeometry);
 assert.deepEqual(ramp.children[0].geometry.shape.points.slice(0,3),[[-4,-1],[4,-1],[4,1]]);
 assert.equal(ramp.rotation.y,Math.PI/2);
 const stairs=h.run(`objectMesh({id:'stairs',type:'stairs',direction:'east',position:{x:0,y:1,z:0},size:{x:8,y:2,z:4},color:'#123456'})`);
 assert.ok(stairs.children[0].geometry instanceof ExtrudeGeometry);
 assert.deepEqual([...new Set(stairs.children[0].geometry.shape.points.map(point=>point[1]))].sort((a,b)=>a-b),[-1,-.5,0,.5,1]);
 assert.equal(stairs.rotation.y,0);
});

test('agent build preview is visible locally and only its approval button grants Apply',async()=>{
 const h=rendererHarness();
 assert.ok(h.has('function showAgentBuildPreview'), 'renderer must show agent proposals as a local preview');
 h.context.agentBuildPreview=null;h.context.settings={threadId:'thread-1'};h.context.connected=true;h.context.busy=false;
 h.context.added=[];h.context.removed=[];h.context.decisions=[];h.context.commands=[];
 h.context.scene={add(mesh){h.context.added.push(mesh);},remove(mesh){h.context.removed.push(mesh);}};
 h.context.objectMesh=object=>({object,traverse(callback){callback({material:{clone(){return {color:{set(){}},transparent:false,opacity:1,depthWrite:true};}}});}});
 h.context.disposeGroup=()=>{};h.context.feedback=()=>{};h.context.updateChatControls=()=>{};h.context.startActivity=()=>{};
 h.context.command=async(...args)=>h.context.commands.push(args);
 h.context.bridge={decideBuildPreview:async(...args)=>h.context.decisions.push(args)};
 h.load('function addMessage(text, kind =', 'function updateChatControls()');
 h.load('function clearAgentBuildPreview(', 'function buildDesign()');
 const objects=[
  {objectType:'block',position:{x:0,y:1,z:0},size:{x:2,y:2,z:2},color:'#123456'},
  {objectType:'bridge',position:{x:8,y:1,z:0},size:{x:10,y:1,z:3},color:'#654321'},
  {objectType:'door',position:{x:12,y:1.5,z:0},size:{x:1,y:3,z:.25},color:'#886644'},
 ];
 h.context.preview={previewId:'preview-1',objects};
 h.run('showAgentBuildPreview(preview)');
 assert.equal(h.context.added.length,3);
 const card=h.element('chat').children[0];
 assert.match(card.textContent,/approve|look right/i);
 const apply=card.children.find(node=>/approve/i.test(node.textContent));
 assert.ok(apply);
 await apply.listeners.click();
 assert.deepEqual(h.context.decisions,[['preview-1','apply','thread-1']]);
 assert.equal(h.context.commands.length,0,'the renderer must ask the agent to apply, never write directly');
});


test('interactive object palette and inspector controls are present in the client',()=>{
 const html=readFileSync(new URL('../src/index.html',import.meta.url),'utf8');
 for(const kind of ['door','gate','button'])assert.match(html,new RegExp('data-kind="'+kind+'"'));
 for(const id of ['edit-use-policy','edit-target-id','edit-target-state','interactive-actions','edit-open','edit-close','edit-use-button'])assert.match(html,new RegExp('id="'+id+'"'));
});

test('interactive palette designs use safe default dimensions',()=>{
 const h=rendererHarness();
 h.element('build-x').value='2';h.element('build-z').value='3';
 h.load('function buildDesign()','function previewSelectedBuild()');
 for(const [type,size] of [['door',{x:1,y:3,z:.25}],['gate',{x:4,y:2,z:.5}],['button',{x:.5,y:.5,z:.25}]]){
  h.context.selectedPreset=type;
  const design=h.run('buildDesign()');
  assert.equal(design.objectType,type);
  assert.deepEqual(JSON.parse(JSON.stringify(design.size)),size);
  assert.equal(design.position.y,size.y/2);
 }
});

test('open doors and gates render visibly different from closed objects',()=>{
 class Group{constructor(){this.children=[];this.userData={};this.position={set(){}};this.rotation={y:0};}add(child){this.children.push(child);}traverse(callback){callback(this);for(const child of this.children)callback(child);}}
 class BoxGeometry{constructor(...dimensions){this.dimensions=dimensions;}}
 class Material{constructor(options){this.color=options.color;this.roughness=options.roughness;}}
 class Mesh{constructor(geometry,material){this.geometry=geometry;this.material=material;this.userData={};this.position={set(){}};}}
 const h=rendererHarness();h.context.THREE={Group,BoxGeometry,Mesh,MeshStandardMaterial:Material};
 h.load('function objectMesh(object)','function pointerRay(');
 h.context.door={id:'door-1',type:'door',position:{x:0,y:1.5,z:0},size:{x:1,y:3,z:.25},color:'#886644',state:'closed'};
 const closed=h.run('objectMesh(door)');
 h.context.door={...h.context.door,state:'open'};
 const open=h.run('objectMesh(door)');
 assert.notEqual(open.rotation.y,closed.rotation.y);
});


test('inspector exposes each object policy and retains a missing button target',()=>{
 const h=rendererHarness();
 const door={id:'door-1',type:'door',ownerId:'alice',color:'#886644',position:{x:0,y:1.5,z:0},size:{x:1,y:3,z:.25},blocksMovement:true,supportsPlayer:false,state:'closed',usePolicy:'all_players',version:4};
 const button={id:'button-1',type:'button',ownerId:'alice',color:'#886644',position:{x:1,y:.25,z:0},size:{x:.5,y:.5,z:.25},blocksMovement:false,supportsPlayer:false,targetId:'removed-door',targetState:'open',usePolicy:'owner_admin',version:2};
 const target={...door,id:'gate-1',type:'gate'};
 h.context.role='admin';h.context.meId='alice';h.context.editing=false;h.context.worldState={objects:[door,target,button]};
 h.load('function fillInspector(object)','function updateMovePreviewFromInspector()');
 h.context.current=door;h.run('fillInspector(current)');
 assert.equal(h.element('edit-use-policy').value,'all_players');
 assert.equal(h.element('interactive-actions').hidden,false);
 assert.equal(h.element('edit-open').hidden,false);
 h.context.current=button;h.run('fillInspector(current)');
 assert.equal(h.element('edit-target-id').value,'removed-door');
 assert.ok(h.element('edit-target-id').children.some(option=>option.value==='removed-door'&&/missing/i.test(option.textContent)));
 assert.equal(h.element('edit-use-button').hidden,false);
});
 
test('viewer owner can manage interactive access without editing object geometry',()=>{
 const html=readFileSync(new URL('../src/index.html',import.meta.url),'utf8');
 assert.match(html,/<fieldset id="edit-interaction-fields"/);
 assert.match(html,/id="edit-interaction-apply"/);
 const h=rendererHarness();
 const door={id:'door-1',type:'door',ownerId:'alice',color:'#886644',position:{x:0,y:1.5,z:0},size:{x:1,y:3,z:.25},blocksMovement:true,supportsPlayer:false,state:'closed',usePolicy:'owner_admin',version:0};
 h.context.role='viewer';h.context.meId='alice';h.context.editing=false;h.context.worldState={objects:[door]};
 h.load('function fillInspector(object)','function updateMovePreviewFromInspector()');
 h.context.current=door;h.run('fillInspector(current)');
 assert.equal(h.element('edit-fields').disabled,true);
 assert.equal(h.element('edit-interaction-fields').hidden,false);
 assert.equal(h.element('edit-interaction-fields').disabled,false);
 assert.equal(h.element('edit-open').disabled,false);
 h.context.meId='bob';h.run('fillInspector(current)');
 assert.equal(h.element('edit-interaction-fields').disabled,true);
 assert.equal(h.element('edit-open').disabled,true);
});

test('interactive controls send explicit state and button versions without client positions',async()=>{
 const h=rendererHarness(),sent=[];
 h.context.request=async(path,method,body)=>{sent.push(JSON.parse(JSON.stringify(body)));return body.type==='use'?{object:{id:'door-1',type:'door',state:'open',version:5},button:{id:'button-1',type:'button',targetId:'door-1',version:4}}:{object:{id:body.id,type:'door',state:body.state??'open',version:body.expectedVersion+1}};};
 h.context.poll=async()=>{};h.context.feedback=()=>{};h.context.editing=false;
 h.context.inspectorBase={id:'door-1',type:'door',version:4};
 h.context.worldState={objects:[{id:'button-1',type:'button',version:3,targetId:'door-1'},{id:'door-1',type:'door',version:4}]};
 h.context.selectedId='door-1';h.context.objectData=new Map([['door-1',{id:'door-1',type:'door',version:4}],['button-1',{id:'button-1',type:'button',version:3,targetId:'door-1'}]]);h.context.fillInspector=()=>{};
 h.context.document.querySelectorAll=()=>[];h.context.settingsGeneration=0;
 h.load('async function command(body)',"for (const button of document.querySelectorAll(");
 assert.equal(typeof h.element('edit-open').listeners.click,'function','open action must be wired');
 await h.element('edit-open').listeners.click();
 h.context.inspectorBase={id:'button-1',type:'button',version:3,targetId:'door-1'};
 await h.element('edit-use-button').listeners.click();
 assert.equal(sent.length,2);
 assert.equal(JSON.stringify(sent[0]),JSON.stringify({type:'set_state',id:'door-1',state:'open',expectedVersion:4}));
 assert.equal(JSON.stringify(sent[1]),JSON.stringify({type:'use',id:'button-1',expectedVersion:3,expectedTargetVersion:4}));
 assert.equal(h.context.objectData.get('door-1').version,5);
 assert.equal(h.context.objectData.get('button-1').type,'button');assert.equal(h.context.objectData.get('button-1').version,4);
 assert.ok(sent.every(command=>!Object.hasOwn(command,'position')));
});
 
test('interactive action does not retry when the response outcome is unknown',async()=>{
 const h=rendererHarness(),sent=[],messages=[];
 const door={id:'door-1',type:'door',version:0};
 h.context.settingsGeneration=0;h.context.editing=false;h.context.inspectorBase=door;h.context.objectData=new Map([[door.id,door]]);
 h.context.command=async body=>{sent.push(JSON.parse(JSON.stringify(body)));throw new Error('Connection timed out');};
 h.context.feedback=message=>messages.push(message);h.context.fillInspector=()=>{};
 h.context.object=door;h.context.body={type:'set_state',id:door.id,state:'open',expectedVersion:0};
 h.load('async function applyInteractiveAction(object, body)',"$('edit-open').addEventListener");
 await h.run('applyInteractiveAction(object, body)');
 assert.equal(sent.length,1);assert.match(messages[0],/Refresh world state before retrying/);
});

test('inspector submits access and button links with exact current values',async()=>{
 async function submit(baseline,changes,role='admin'){
  const h=rendererHarness(),sent=[];
  h.context.selectedId=baseline.id;h.context.inspectorBase=structuredClone(baseline);h.context.objectData=new Map([[baseline.id,structuredClone(baseline)]]);
  h.context.role=role;h.context.meId='alice';h.context.editing=false;h.context.settingsGeneration=0;h.context.inspectorDirty=false;
  h.context.command=async body=>{sent.push(JSON.parse(JSON.stringify(body)));return {object:{...baseline,...changes,version:baseline.version+1}};};
  h.context.clearMovePreview=()=>{};h.context.fillInspector=()=>{};h.context.feedback=()=>{};h.context.request=async()=>({error:'unexpected'});
  for(const field of ['position','size'])for(const axis of ['x','y','z'])h.element('edit-'+field+'-'+axis).value=String(baseline[field][axis]);
  h.element('edit-color').value=baseline.color;
  h.element('edit-blocks-movement').checked=baseline.blocksMovement;h.element('edit-supports-player').checked=baseline.supportsPlayer;
  h.element('edit-use-policy').value=changes.usePolicy??baseline.usePolicy;
  h.element('edit-target-id').value=changes.targetId??baseline.targetId??'';
  h.element('edit-target-state').value=changes.targetState??baseline.targetState??'open';
  h.load("$('edit-form').addEventListener('submit'","function setFullscreenState(");
  await h.element('edit-form').listeners.submit({preventDefault(){}});
  return sent[0];
 }
 const door={id:'door-1',type:'door',ownerId:'alice',color:'#886644',position:{x:0,y:1.5,z:0},size:{x:1,y:3,z:.25},blocksMovement:true,supportsPlayer:false,state:'closed',usePolicy:'owner_admin',version:0};
 const policy=await submit(door,{usePolicy:'all_players'});
 assert.ok(policy,'access policy changes must produce a server command');
 assert.equal(policy.usePolicy,'all_players');assert.deepEqual(policy.expected,{usePolicy:'owner_admin'});
 const button={id:'button-1',type:'button',ownerId:'alice',color:'#886644',position:{x:1,y:.25,z:0},size:{x:.5,y:.5,z:.25},blocksMovement:false,supportsPlayer:false,targetId:null,targetState:'open',usePolicy:'owner_admin',version:0};
 const link=await submit(button,{targetId:'door-1',targetState:'closed'});
 assert.ok(link,'button link changes must produce a server command');
 assert.equal(link.targetId,'door-1');assert.equal(link.targetState,'closed');
 assert.deepEqual(link.expected,{targetId:null,targetState:'open'});
 const viewerPolicy=await submit(door,{usePolicy:'all_players'},'viewer');
 assert.deepEqual(viewerPolicy.expected,{usePolicy:'owner_admin'});
});


test('lamp and lighting controls are exposed in the client',()=>{
 const html=readFileSync(new URL('../src/index.html',import.meta.url),'utf8');
 assert.match(html,/data-kind="lamp"/);
 for(const id of ['edit-lamp-intensity','edit-lamp-range','edit-lamp-on','edit-lamp-off','world-light-ambient','world-light-sun','world-light-preview','world-light-apply','world-light-cancel','world-light-message','lighting-quality'])
  assert.match(html,new RegExp('id="'+id+'"'));
});

test('lamp mesh has a visible on/off emitter and a bounded point light without shadows',()=>{
 class Group{constructor(){this.children=[];this.userData={};this.position={set(){}};this.rotation={y:0};}add(child){this.children.push(child);}traverse(callback){callback(this);for(const child of this.children)child.traverse?child.traverse(callback):callback(child);}}
 class BoxGeometry{constructor(...dimensions){this.dimensions=dimensions;}dispose(){}}
 class SphereGeometry{constructor(...dimensions){this.dimensions=dimensions;}dispose(){}}
 class Material{constructor(options){this.options=options;this.color={value:options.color,set(value){this.value=value;}};this.emissive=options.emissive;this.emissiveIntensity=options.emissiveIntensity??0;}dispose(){}}
 class Mesh{constructor(geometry,material){this.geometry=geometry;this.material=material;this.userData={};this.position={x:0,y:0,z:0,set(x,y,z){this.x=x;this.y=y;this.z=z;}};}}
 class PointLight{constructor(color,intensity,distance,decay){this.color=color;this.intensity=intensity;this.distance=distance;this.decay=decay;this.visible=true;this.castShadow=false;this.position={x:0,y:0,z:0,set(x,y,z){this.x=x;this.y=y;this.z=z;}};}}
 const h=rendererHarness();h.context.THREE={Group,BoxGeometry,SphereGeometry,Mesh,PointLight,MeshStandardMaterial:Material};
 h.load('function objectMesh(object)','function updateBeaconLabels()');
 h.context.lamp={id:'lamp-1',type:'lamp',position:{x:0,y:1,z:0},size:{x:1,y:2,z:1},color:'#ffcc66',on:true,intensity:3,range:11};
 const on=h.run('objectMesh(lamp)'),light=on.children.find(child=>child instanceof PointLight);
 assert.ok(light);assert.equal(light.intensity,3);assert.equal(light.distance,11);assert.equal(light.castShadow,false);
 assert.ok(on.userData.lampEmitter.material.emissiveIntensity>0);
 assert.ok(on.userData.lampEmitter.position.y-on.userData.lampEmitter.geometry.dimensions[0]>=h.context.lamp.size.y/2,'the complete emitter must sit above the opaque lamp body');
 assert.ok(light.position.y>h.context.lamp.size.y/2,'the point light must sit outside the opaque lamp body');
 h.context.lamp={...h.context.lamp,on:false};const off=h.run('objectMesh(lamp)');
 assert.equal(off.userData.lampLight.intensity,0);assert.equal(off.userData.lampEmitter.material.emissiveIntensity,0);
});

test('local quality caps nearest enabled lamps and reduced mode removes sun shadows',()=>{
 const h=rendererHarness();assert.ok(h.has('function updateWorldLighting('),'renderer must apply shared and local lighting settings');
 h.context.worldLightingPreview=null;h.context.role='admin';h.context.settings={lightingQuality:'full'};
 h.context.ambientLight={intensity:0};h.context.sunLight={intensity:0,castShadow:false};h.context.renderer={shadowMap:{enabled:false}};
 h.context.controls={target:{x:0,y:0,z:0}};h.context.lampLights=new Map();
 for(let i=0;i<10;i++){
  const id='lamp-'+i,object={id,type:'lamp',on:true,intensity:2,range:20,position:{x:i+1,y:0,z:0}};
  h.context.lampLights.set(id,{object,light:{visible:false},emitter:{material:{emissiveIntensity:0}}});
 }
 h.context.lampLights.get('lamp-0').object.on=false;
 h.context.worldState={lighting:{version:0,ambientIntensity:1.25,sunIntensity:2.5}};
 h.load('function updateWorldLighting(','function updateBeaconLabels()');
 h.run('updateWorldLighting(worldState)');
 assert.equal(h.context.ambientLight.intensity,1.25);assert.equal(h.context.sunLight.intensity,2.5);
 assert.equal([...h.context.lampLights].filter(([,item])=>item.light.visible).length,8);
 assert.equal(h.context.lampLights.get('lamp-0').light.visible,false);
 assert.deepEqual([...h.context.lampLights].filter(([,item])=>item.light.visible).map(([id])=>id),Array.from({length:8},(_,i)=>'lamp-'+(i+1)));
 assert.equal(h.context.sunLight.castShadow,true);assert.equal(h.context.renderer.shadowMap.enabled,true);
 h.context.settings.lightingQuality='reduced';h.run('updateWorldLighting(worldState)');
 assert.equal([...h.context.lampLights].filter(([,item])=>item.light.visible).length,4);
 assert.deepEqual([...h.context.lampLights].filter(([,item])=>item.light.visible).map(([id])=>id),['lamp-1','lamp-2','lamp-3','lamp-4']);
 assert.equal(h.context.sunLight.castShadow,false);assert.equal(h.context.renderer.shadowMap.enabled,false);
});

test('world lighting Preview and Cancel are local; Apply sends one versioned command',async()=>{
 const h=rendererHarness();assert.ok(h.has('function previewWorldLighting('),'lighting controls must support a local preview');
 h.context.worldLightingPreview=null;h.context.role='admin';h.context.editing=false;h.context.settings={lightingQuality:'full'};
 h.context.ambientLight={intensity:2.6};h.context.sunLight={intensity:3.1,castShadow:true};h.context.renderer={shadowMap:{enabled:true}};
 h.context.controls={target:{x:0,y:0,z:0}};h.context.lampLights=new Map();
 h.context.worldState={revision:7,lighting:{version:2,ambientIntensity:2.6,sunIntensity:3.1}};
 h.context.request=async(path,method,body)=>{h.context.requests.push({path,method,body});return {revision:8,lighting:{version:3,ambientIntensity:1.2,sunIntensity:2.4}};};
 h.context.requests=[];h.context.feedback=()=>{};h.context.updateLightingControls=()=>{};
 h.element('world-light-ambient').value='1.2';h.element('world-light-sun').value='2.4';
 h.load('function updateWorldLighting(','function updateBeaconLabels()');
 h.run('previewWorldLighting()');
 assert.equal(h.context.requests.length,0);assert.equal(h.context.ambientLight.intensity,1.2);assert.match(h.element('world-light-message').textContent,/preview/i);
 h.run('cancelWorldLightingPreview()');
 assert.equal(h.context.requests.length,0);assert.equal(h.context.ambientLight.intensity,2.6);
 h.element('world-light-ambient').value='1.2';h.element('world-light-sun').value='2.4';
 h.run('previewWorldLighting()');await h.run('applyWorldLightingPreview()');
 assert.equal(h.context.requests.length,1);
 assert.deepEqual(JSON.parse(JSON.stringify(h.context.requests[0])),{path:'/command',method:'POST',body:{type:'set_lighting',ambientIntensity:1.2,sunIntensity:2.4,expectedVersion:2}});
 assert.deepEqual(h.context.worldState.lighting,{version:3,ambientIntensity:1.2,sunIntensity:2.4});
});

test('unknown lighting Apply is reconciled from fresh server state before releasing its preview',async()=>{
 const h=rendererHarness();assert.ok(h.has('async function applyWorldLightingPreview('));
 h.context.worldLightingPreview={version:1,baseline:{version:1,ambientIntensity:2.6,sunIntensity:3.1},ambientIntensity:1,sunIntensity:2,attempted:false};
 h.context.role='admin';h.context.editing=false;h.context.settings={lightingQuality:'full'};h.context.latestStateRevision=5;
 h.context.worldState={revision:5,lighting:{version:1,ambientIntensity:2.6,sunIntensity:3.1}};
 h.context.requests=[];
 h.context.request=async(path,method)=>{h.context.requests.push([path,method]);if(method==='POST')throw new Error('timed out');return {revision:6,lighting:{version:2,ambientIntensity:1,sunIntensity:2},objects:[],players:[]};};
 h.context.renderWorld=state=>{h.context.worldState=state;h.context.latestStateRevision=state.revision;};
 h.context.feedback=()=>{};h.context.ambientLight={intensity:2.6};h.context.sunLight={intensity:3.1};h.context.renderer={shadowMap:{enabled:true}};h.context.controls={target:{x:0,y:0,z:0}};
 h.load('function updateLightingControls(','function labelTexture(');
 await h.run('applyWorldLightingPreview()');
 assert.deepEqual(JSON.parse(JSON.stringify(h.context.requests)),[['/command','POST'],['/state',undefined]]);
 assert.equal(h.context.worldLightingPreview,null);
 assert.deepEqual(JSON.parse(JSON.stringify(h.context.worldState.lighting)),{version:2,ambientIntensity:1,sunIntensity:2});
 assert.match(h.element('world-light-message').textContent,/refreshed/i);
 assert.doesNotMatch(h.element('world-light-message').textContent,/shared lighting was not changed/i);
});

test('failed lighting refresh keeps attempted preview locked and never claims it was canceled',async()=>{
 const h=rendererHarness();assert.ok(h.has('function cancelWorldLightingPreview('));
 h.context.worldLightingPreview={version:1,baseline:{version:1,ambientIntensity:2.6,sunIntensity:3.1},ambientIntensity:1,sunIntensity:2,attempted:false};
 h.context.role='admin';h.context.editing=false;h.context.settings={lightingQuality:'full'};h.context.latestStateRevision=5;
 h.context.worldState={revision:5,lighting:{version:1,ambientIntensity:2.6,sunIntensity:3.1}};
 h.context.requests=[];
 h.context.request=async(path,method)=>{h.context.requests.push([path,method]);throw new Error(method==='POST'?'timed out':'offline');};
 h.context.renderWorld=()=>{throw new Error('must not render unavailable state');};
 h.context.feedback=()=>{};h.context.ambientLight={intensity:2.6};h.context.sunLight={intensity:3.1};h.context.renderer={shadowMap:{enabled:true}};h.context.controls={target:{x:0,y:0,z:0}};
 h.load('function updateLightingControls(','function labelTexture(');
 await h.run('applyWorldLightingPreview()');
 assert.equal(h.context.worldLightingPreview.attempted,true);
 assert.equal(h.element('world-light-cancel').disabled,true);
 h.run('cancelWorldLightingPreview()');
 assert.equal(h.context.worldLightingPreview.attempted,true);
 assert.match(h.element('world-light-message').textContent,/unknown|reconnect/i);
 assert.doesNotMatch(h.element('world-light-message').textContent,/shared lighting was not changed/i);
});
