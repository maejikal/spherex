import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewBlinkAnalysis } from '../src/review/blink.ts';
const item={id:'case',analysis:{ra:12,dec:-8,mode:'local',frames:[{id:'a',imageUrl:'/source-a'},{id:'b',imageUrl:'/source-b'}]}};
const images=['b','a'].map(frameId=>({caseId:'case',frameId,blob:new Blob([frameId])}));
test('opens exact saved observations in frame order, preserving center/mode and original provenance',()=>{
 let count=0; const result=reviewBlinkAnalysis(item,images,()=>`blob:${++count}`);
 assert.equal(result.ra,12); assert.equal(result.dec,-8); assert.equal(result.mode,'local');
 assert.deepEqual(result.frames.map(f=>f.id),['a','b']);
 assert.deepEqual(result.frames.map(f=>f.imageUrl),['blob:1','blob:2']);
 assert.equal(item.analysis.frames[0].imageUrl,'/source-a');
});
test('incomplete, empty or other-case evidence fails before creating any URLs',()=>{
 for(const evidence of [[],images.slice(0,1),images.map(image=>({...image,caseId:'other'})),images.map(image=>({...image,blob:new Blob([])}))]) {
  assert.throws(()=>reviewBlinkAnalysis(item,evidence,()=>{assert.fail('must validate all evidence first');}),/images are missing/);
 }
});
