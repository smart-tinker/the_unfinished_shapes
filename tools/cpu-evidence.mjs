// Parse llama.cpp allocation diagnostics, never infer hardware from model paths.
export function createCpuEvidence() {
  const allocations=[];
  const gpuOffloads=[];
  function acceptLine(line) {
    const allocation=line.match(/\bload_tensors:\s+([A-Za-z0-9_:-]+)\s+model buffer size\s*=\s*(\d+(?:\.\d+)?)\s+MiB\s*$/);
    if(allocation) allocations.push({backend:allocation[1],mib:Number(allocation[2]),line});
    const offload=line.match(/\boffloaded\s+(\d+)\/\d+\s+layers to GPU\s*$/);
    if(offload) gpuOffloads.push({layers:Number(offload[1]),line});
  }
  function stream() {
    let partial='';
    return {
      write(chunk) {
        const lines=(partial+String(chunk)).split('\n');
        partial=lines.pop();
        // Ordinary diagnostic lines are short; retain a bounded incomplete line.
        if(partial.length>65536)partial=partial.slice(-65536);
        for(const line of lines)acceptLine(line.trimEnd());
      },
      end() {if(partial)acceptLine(partial.trimEnd());partial='';},
    };
  }
  function result() {
    const positive=allocations.filter(a=>a.mib>0);
    const cpuOnly=positive.length>0 && positive.every(a=>a.backend==='CPU'||a.backend==='CPU_Mapped'||a.backend==='CPU_REPACK'||a.backend==='AMX') && !gpuOffloads.some(g=>g.layers>0);
    return {cpuOnly,allocations:[...allocations],gpuOffloads:[...gpuOffloads]};
  }
  return {stream,result};
}
