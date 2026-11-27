import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as diagnostics from '../scripts/updater-smoke-diagnostics.mjs';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

test('ZIP pipeline diagnostic uses each requested batch size without changing bytes', async () => {
  assert.equal(typeof diagnostics.runZipSinkPipeline, 'function');

  const input = [
    Buffer.alloc(160 * 1024, 0x31),
    Buffer.alloc(160 * 1024, 0x62),
  ];
  const expected = Buffer.concat(input);
  const collect = async batchBytes => {
    const chunks = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    await diagnostics.runZipSinkPipeline(Readable.from(input), sink, batchBytes);
    return chunks;
  };

  const productionBatcher = await collect(256 * 1024);
  const largerBatcher = await collect(1024 * 1024);
  assert.deepEqual(productionBatcher.map(chunk => chunk.length), [256 * 1024, 64 * 1024]);
  assert.deepEqual(largerBatcher.map(chunk => chunk.length), [320 * 1024]);

  const directChunks = [];
  const directSink = new Writable({
    write(chunk, _encoding, callback) {
      directChunks.push(Buffer.from(chunk));
      callback();
    },
  });
  await pipeline(Readable.from(input), directSink);
  assert.deepEqual(directChunks.map(chunk => chunk.length), input.map(chunk => chunk.length));
  assert.deepEqual(Buffer.concat(directChunks), expected);
  assert.deepEqual(Buffer.concat(directChunks), Buffer.concat(productionBatcher));
  for (const chunks of [productionBatcher, largerBatcher]) {
    assert.equal(chunks.reduce((total, chunk) => total + chunk.length, 0), expected.length);
    assert.deepEqual(Buffer.concat(chunks), expected);
  }
});

test('ZIP comparison exposes paired disk and memory Deflate file measurements', () => {
  const plan = [
    { trial: 1, arm: 'disk-file', sink: 'node-fs-file' },
    { trial: 1, arm: 'memory-file', sink: 'node-fs-file' },
    { trial: 2, arm: 'disk-file', sink: 'node-fs-file' },
    { trial: 2, arm: 'memory-file', sink: 'node-fs-file' },
  ];
  const arms = plan.map(({ trial, arm, sink }) => ({
    trial,
    arm,
    sink,
    batchBytes: 256 * 1024,
    outcome: 'completed',
    wallMs: 10_000,
    cpuUserMs: 100,
    cpuSystemMs: 20,
    compressedBytesRead: 111_522_616,
    decodedBytes: 249_832_448,
    sinkBytesProcessed: 249_832_448,
    sinkWritableLength: 0,
    sinkNeedDrain: false,
    writeCallbackWaitMs: 900,
    sourceReadableEnded: true,
    sinkWritableFinished: true,
    sinkClosed: true,
    cleanupStatus: 'removed',
    privatePath: 'C:/private/archive.zip',
    privateError: 'private filesystem error',
  }));
  const comparison = diagnostics.safeZipBatcherComparison({
    assetMatches: true,
    memorySourceVerified: true,
    entrySequence: 12,
    compression: 'deflate',
    entryCompressedSize: 111_522_616,
    entryUncompressedSize: 249_832_448,
    entryNonAsar: true,
    entryMatches: true,
    batchBytes: 256 * 1024,
    readHighWaterMarkBytes: 256 * 1024,
    writeHighWaterMarkBytes: 16 * 1024,
    arms,
    privatePath: 'C:/private/archive.zip',
  });

  assert.equal(comparison.assetMatches, true);
  assert.equal(comparison.memorySourceVerified, true);
  assert.equal(comparison.entryMatches, true);
  assert.equal(comparison.batchBytes, 256 * 1024);
  assert.deepEqual(comparison.armOrder, plan.map(({ arm }) => arm));
  assert.deepEqual(comparison.sinkOrder, plan.map(({ sink }) => sink));
  assert.deepEqual(comparison.arms.map(({ trial, arm, sink, batchBytes, compressedBytesRead, countersMatch }) =>
    ({ trial, arm, sink, batchBytes, compressedBytesRead, countersMatch })), [
    { ...plan[0], batchBytes: 256 * 1024, compressedBytesRead: 111_522_616, countersMatch: true },
    { ...plan[1], batchBytes: 256 * 1024, compressedBytesRead: null, countersMatch: true },
    { ...plan[2], batchBytes: 256 * 1024, compressedBytesRead: 111_522_616, countersMatch: true },
    { ...plan[3], batchBytes: 256 * 1024, compressedBytesRead: null, countersMatch: true },
  ]);
  assert.equal(comparison.arms[2].cleanupStatus, 'removed');
  assert.equal(comparison.arms[0].cleanupStatus, 'removed');
  assert.equal(comparison.cacheCaveat, 'post-digest; filesystem-read-cache-not-reset');
  assert.equal(comparison.measurementScope, 'disk-vs-memory-file-sink');
  assert.deepEqual(comparison.arms.map(({ sinkWritableLength, sinkNeedDrain, writeCallbackWaitMs }) => [
    sinkWritableLength, sinkNeedDrain, writeCallbackWaitMs,
  ]), [[0, false, 900], [0, false, 900], [0, false, 900], [0, false, 900]]);
  assert.equal(JSON.stringify(comparison).includes('C:/private'), false);
  assert.equal(JSON.stringify(comparison).includes('private filesystem error'), false);
  assert.equal(Object.keys(comparison).includes('privatePath'), false);
  assert.deepEqual(comparison.arms.map(({ sink }) => sink), plan.map(({ sink }) => sink));

  const bounded = diagnostics.safeZipBatcherComparison({
    assetMatches: true,
    batchBytes: Number.MAX_SAFE_INTEGER,
    sinkOrder: ['C:/private/path'],
    arms: [{ trial: 1, sink: 'C:/private/sink', batchBytes: 333, privatePath: 'C:/private/path', privateError: 'private error' }],
  });
  assert.equal(bounded.batchBytes, null);
  assert.equal(bounded.sinkOrder[0], 'unknown');
  assert.equal(bounded.arms[0].sink, 'unknown');
  assert.equal(bounded.arms[0].batchBytes, null);
  assert.equal(JSON.stringify(bounded).includes('C:/private'), false);
  assert.equal(JSON.stringify(bounded).includes('private error'), false);
});

test('ZIP comparison accepts matched verified-memory Deflate file and discard arms only', () => {
  const plan = [
    { trial: 1, arm: 'memory-file', sink: 'node-fs-file' },
    { trial: 1, arm: 'memory-discard', sink: 'count-discard' },
    { trial: 2, arm: 'memory-discard', sink: 'count-discard' },
    { trial: 2, arm: 'memory-file', sink: 'node-fs-file' },
  ];
  const arms = plan.map(({ trial, arm, sink }) => ({
    trial, arm, sink, batchBytes: 262_144, outcome: 'time-limit',
    wallMs: 15_000, cpuUserMs: 700, cpuSystemMs: 500, compressedBytesRead: null,
    decodedBytes: 100_000, sinkBytesProcessed: arm === 'memory-file' ? 98_304 : 100_000,
    sinkWritableLength: 0, sinkNeedDrain: false, writeCallbackWaitMs: 900,
    sourceReadableEnded: false, sinkWritableFinished: false, sinkClosed: true,
    cleanupStatus: arm === 'memory-file' ? 'removed' : 'not-created',
  }));
  const comparison = diagnostics.safeZipBatcherComparison({
    assetMatches: true, memorySourceVerified: true,
    entrySequence: 12, compression: 'deflate', entryCompressedSize: 111_522_616,
    entryUncompressedSize: 249_832_448, entryNonAsar: true, entryMatches: true,
    batchBytes: 262_144, readHighWaterMarkBytes: 262_144,
    writeHighWaterMarkBytes: 16_384, arms,
  });

  const [invalid] = diagnostics.safeZipBatcherComparison({
    arms: [{
      trial: 1, arm: 'C:/private/invalid-arm', sink: 'C:/private/sink',
      batchBytes: 262_144, privatePath: 'C:/private/path',
    }],
  }).arms;
  assert.equal(invalid.arm, 'unknown');
  assert.equal(invalid.sink, 'unknown');
  assert.equal(invalid.batchBytes, null);
  assert.equal((JSON.stringify(comparison) + JSON.stringify(invalid)).includes('C:/private'), false);

  assert.equal(comparison.memorySourceVerified, true);
  assert.equal(comparison.entryMatches, true);
  assert.deepEqual(comparison.armOrder, plan.map(({ arm }) => arm));
  assert.deepEqual(comparison.sinkOrder, plan.map(({ sink }) => sink));
  assert.equal(comparison.measurementScope, 'verified-memory-deflate-file-vs-discard');
  assert.equal(comparison.cacheCaveat, 'verified-buffer; sink-filesystem-cache-not-reset');
});
