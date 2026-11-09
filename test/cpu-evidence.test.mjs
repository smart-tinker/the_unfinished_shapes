import test from 'node:test';
import assert from 'node:assert/strict';
import { createCpuEvidence } from '../tools/cpu-evidence.mjs';

test('model file path containing tus-cpu is not allocation evidence',()=>{
 const evidence=createCpuEvidence();const log=evidence.stream();
 log.write('loading model from /tmp/tus-cpu/qwen3-1.7b.gguf\n');
 assert.equal(evidence.result().cpuOnly,false);assert.deepEqual(evidence.result().allocations,[]);
});
test('CPU and CPU_Mapped positive allocations are actual evidence',()=>{
 const evidence=createCpuEvidence();const log=evidence.stream();
 log.write('load_tensors:          CPU model buffer size =   10.25 MiB\n');
 log.write('load_tensors:   CPU_Mapped model buffer size =  512.00 MiB\n');
 assert.equal(evidence.result().cpuOnly,true);assert.equal(evidence.result().allocations.length,2);
});
test('GPU allocations and positive offload contradict CPU-only claim',()=>{
 for(const contradictory of ['load_tensors: CUDA0 model buffer size = 12.0 MiB','load_tensors: Vulkan0 model buffer size = 12.0 MiB','load_tensors: offloaded 1/29 layers to GPU']) {
  const evidence=createCpuEvidence();const log=evidence.stream();
  log.write(`load_tensors: CPU model buffer size = 1.0 MiB\n${contradictory}\n`);
  assert.equal(evidence.result().cpuOnly,false);
 }
});
test('zero GPU offload is compatible but does not itself prove CPU allocation',()=>{
 const evidence=createCpuEvidence();const log=evidence.stream();
 log.write('load_tensors: offloaded 0/29 layers to GPU\n');assert.equal(evidence.result().cpuOnly,false);
 log.write('load_tensors: CPU_Mapped model buffer size = 2.0 MiB\n');assert.equal(evidence.result().cpuOnly,true);
});
test('zero allocation, generic CPU mention, path and malformed lines do not qualify',()=>{
 const evidence=createCpuEvidence();const log=evidence.stream();
 log.write('load_tensors: CPU model buffer size = 0.00 MiB\n');
 log.write('CPU model loaded successfully\n/tmp/load_tensors: CPU/model.gguf\nload_tensors: CPU model buffer size = NaN MiB\n');
 assert.equal(evidence.result().cpuOnly,false);
});
test('split lines and independent stdout/stderr buffers preserve exact evidence',()=>{
 const evidence=createCpuEvidence();const out=evidence.stream(),err=evidence.stream();
 out.write('2026-11-07 load_tensors: CPU_Map');err.write('unrelated stderr\n');
 assert.equal(evidence.result().cpuOnly,false);
 out.write('ped model buffer size = 128.50 MiB');out.end();err.end();
 assert.equal(evidence.result().cpuOnly,true);assert.equal(evidence.result().allocations[0].mib,128.5);
});

test('official CPU_REPACK allocations are CPU evidence, unknown CPU-prefixed names are not',()=>{
 const evidence=createCpuEvidence();const log=evidence.stream();
 log.write('load_tensors: CPU_REPACK model buffer size = 630.00 MiB\n');
 assert.equal(evidence.result().cpuOnly,true);
 for(const backend of ['CPU_CUDA','CPU_REPACK_FAKE','GPU_CPU_REPACK']) {
  const other=createCpuEvidence();other.stream().write(`load_tensors: ${backend} model buffer size = 1.00 MiB\n`);
  assert.equal(other.result().cpuOnly,false);
 }
 log.write('load_tensors: CUDA0 model buffer size = 1.00 MiB\n');
 assert.equal(evidence.result().cpuOnly,false);
});

test('official AMX allocations on the CPU runner qualify without accepting GPU or unknown backends',()=>{
 const evidence=createCpuEvidence();const log=evidence.stream();
 log.write('0.00.342.738 I load_tensors: offloaded 0/29 layers to GPU\n');
 log.write('0.00.342.743 I load_tensors:          AMX model buffer size =  1140.74 MiB\n');
 log.write('0.00.342.744 I load_tensors:   CPU_Mapped model buffer size =   166.93 MiB\n');
 assert.equal(evidence.result().cpuOnly,true);
 for(const backend of ['AMX_CUDA','GPU_AMX','CUDA0','Vulkan0']) {
  const mixed=createCpuEvidence();mixed.stream().write(`load_tensors: AMX model buffer size = 1.00 MiB\nload_tensors: ${backend} model buffer size = 1.00 MiB\n`);
  assert.equal(mixed.result().cpuOnly,false);
 }
 log.write('load_tensors: offloaded 1/29 layers to GPU\n');
 assert.equal(evidence.result().cpuOnly,false);
});
