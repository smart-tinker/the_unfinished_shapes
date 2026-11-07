import test from 'node:test';
import assert from 'node:assert/strict';
import {createModelDiagnostics} from '../tools/model-diagnostics.mjs';
test('SSE chunk observer retains metadata and never synthetic content',()=>{
 const d=createModelDiagnostics(()=>1234),r=d.request();r.input('secret prompt');r.status(200);
 r.data('data: {"type":"response.output_text.delta","delta":"PRIVATE');
 r.data(' TEXT"}\n\ndata: {"type":"response.output_item.added","item":{"type":"reasoning","text":"HIDDEN"}}\n\n');
 r.data('data: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":2}}}\n\n');r.end();
 const out=d.result(),encoded=JSON.stringify(out);
 assert.equal(out.requests[0].eventCounts['response.output_text.delta'],1);assert.equal(out.requests[0].itemTypes.reasoning,1);
 assert.deepEqual(out.requests[0].usage,{input_tokens:4,output_tokens:2});assert.equal(out.requests[0].requestBytes,13);
 assert.doesNotMatch(encoded,/PRIVATE|HIDDEN|secret prompt/);
});
test('numeric timing whitelist ignores arbitrary model logs',()=>{
 const d=createModelDiagnostics();d.logLine('prompt: PRIVATE');d.logLine('slot print_timing: prompt eval time = 55.20 ms / 10 tokens');d.logLine('slot print_timing: eval time = 19.5 ms / 2 tokens');
 assert.deepEqual(d.result().logTimings,[{kind:'prompt eval time',milliseconds:55.2,tokens:10},{kind:'eval time',milliseconds:19.5,tokens:2}]);
});
test('malformed or oversized events are bounded and never retained',()=>{
 const d=createModelDiagnostics(),r=d.request();r.data('data: not json\n\n');r.data('z'.repeat(270000));r.error();r.end();
 assert.deepEqual(d.result().requests[0].eventCounts,{});assert.equal(d.result().requests[0].oversizedEventDiscarded,true);assert.equal(d.result().requests[0].transportError,true);
});
