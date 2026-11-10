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
