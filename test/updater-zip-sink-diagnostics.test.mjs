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

test('ZIP comparison exposes raw, batched and direct Deflate measurements', () => {
  const plan = [
    { trial: 1, arm: 'raw-read', sink: 'count-discard' },
    { trial: 1, arm: 'deflate-discard', sink: 'count-discard' },
    { trial: 1, arm: 'deflate-file', sink: 'node-fs-file' },
    { trial: 2, arm: 'deflate-direct', sink: 'count-discard' },
  ];
  const arms = plan.map(({ trial, arm, sink }) => ({
    trial,
    arm,
    sink,
    batchBytes: ['deflate-discard', 'deflate-file'].includes(arm) ? 256 * 1024 : null,
    outcome: 'completed',
    wallMs: 10_000,
    cpuUserMs: 100,
    cpuSystemMs: 20,
    compressedBytesRead: 111_522_616,
    decodedBytes: arm === 'raw-read' ? null : 249_832_448,
    sinkBytesProcessed: arm === 'raw-read' ? 111_522_616 : 249_832_448,
    sinkWritableLength: 0,
    sinkNeedDrain: false,
    writeCallbackWaitMs: sink === 'node-fs-file' ? 900 : 0,
    sourceReadableEnded: true,
    sinkWritableFinished: true,
    sinkClosed: true,
    cleanupStatus: sink === 'node-fs-file' ? 'removed' : 'not-created',
    privatePath: 'C:/private/archive.zip',
    privateError: 'private filesystem error',
  }));
  const comparison = diagnostics.safeZipBatcherComparison({
    assetMatches: true,
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
  assert.equal(comparison.entryMatches, true);
  assert.equal(comparison.batchBytes, 256 * 1024);
  assert.deepEqual(comparison.armOrder, plan.map(({ arm }) => arm));
  assert.deepEqual(comparison.sinkOrder, plan.map(({ sink }) => sink));
  assert.deepEqual(comparison.arms.map(({ trial, arm, sink, batchBytes, countersMatch }) => ({ trial, arm, sink, batchBytes, countersMatch })), [
    { ...plan[0], batchBytes: null, countersMatch: null },
    { ...plan[1], batchBytes: 256 * 1024, countersMatch: true },
    { ...plan[2], batchBytes: 256 * 1024, countersMatch: true },
    { ...plan[3], batchBytes: null, countersMatch: true },
  ]);
  assert.equal(comparison.arms[0].sinkBytesProcessed, 111_522_616);
  assert.equal(comparison.arms[2].cleanupStatus, 'removed');
  assert.equal(comparison.arms[0].cleanupStatus, 'not-created');
  assert.equal(comparison.cacheCaveat, 'post-digest; filesystem-read-cache-not-reset');
  assert.equal(comparison.measurementScope, 'raw-reader-and-deflate-pipeline');
  assert.deepEqual(comparison.arms.map(({ sinkWritableLength, sinkNeedDrain, writeCallbackWaitMs }) => [
    sinkWritableLength, sinkNeedDrain, writeCallbackWaitMs,
  ]), [[0, false, 0], [0, false, 0], [0, false, 900], [0, false, 0]]);
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
