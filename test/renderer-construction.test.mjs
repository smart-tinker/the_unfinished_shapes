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
