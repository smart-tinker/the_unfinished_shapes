import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

  let discardedBytes = 0;
  const discardedHash = createHash('sha256');
  const discardSink = new Writable({
    highWaterMark: 16 * 1024,
    write(chunk, _encoding, callback) {
      discardedBytes += chunk.length;
      discardedHash.update(chunk);
      callback();
    },
  });
  await diagnostics.runZipSinkPipeline(Readable.from(input), discardSink, 256 * 1024);
  assert.equal(discardedBytes, expected.length);
  assert.equal(discardedHash.digest('hex'), createHash('sha256').update(expected).digest('hex'));
  assert.equal(discardSink.writableFinished, true);
});

test('ZIP comparison exposes counterbalanced verified-memory Deflate file/discard measurements', () => {
  const plan = [
    { trial: 1, arm: 'memory-file', sink: 'node-fs-file' },
    { trial: 1, arm: 'memory-discard', sink: 'count-discard' },
    { trial: 2, arm: 'memory-discard', sink: 'count-discard' },
    { trial: 2, arm: 'memory-file', sink: 'node-fs-file' },
  ];
  const arms = plan.map(({ trial, arm, sink }) => ({
    trial, arm, sink, batchBytes: 256 * 1024, outcome: 'completed',
    wallMs: 10_000, cpuUserMs: 100, cpuSystemMs: 20, compressedBytesRead: null,
    decodedBytes: 249_832_448, sinkBytesProcessed: 249_832_448,
    sinkWritableLength: 0, sinkNeedDrain: false, writeCallbackWaitMs: 900,
    sourceReadableEnded: true, sinkWritableFinished: true, sinkClosed: true,
    cleanupStatus: sink === 'node-fs-file' ? 'removed' : 'not-created',
    privatePath: 'C:/private/archive.zip', privateError: 'private filesystem error',
  }));
  const comparison = diagnostics.safeZipBatcherComparison({
    assetMatches: true, memorySourceVerified: true,
    entrySequence: 12, compression: 'deflate', entryCompressedSize: 111_522_616,
    entryUncompressedSize: 249_832_448, entryNonAsar: true, entryMatches: true,
    batchBytes: 256 * 1024, readHighWaterMarkBytes: 256 * 1024,
    writeHighWaterMarkBytes: 16 * 1024, arms,
    privatePath: 'C:/private/archive.zip',
  });

  const [invalid] = diagnostics.safeZipBatcherComparison({
    arms: [{
      trial: 1, arm: 'C:/private/invalid-arm', sink: 'C:/private/sink',
      batchBytes: 256 * 1024, privatePath: 'C:/private/path', privateError: 'private error',
    }],
  }).arms;
  const [bounded] = diagnostics.safeZipBatcherComparison({
    arms: [{
      trial: 1, arm: 'memory-discard', sink: 'count-discard',
      batchBytes: 256 * 1024, wallMs: 60_001, cpuUserMs: Number.MAX_SAFE_INTEGER,
      cpuSystemMs: 'private', decodedBytes: 1_073_741_825,
      sinkBytesProcessed: 1_073_741_825, sinkWritableLength: Number.MAX_SAFE_INTEGER,
      sinkNeedDrain: 'private', writeCallbackWaitMs: 120_001,
      cleanupStatus: 'private', sourcePath: 'C:/private/archive/entry.bin', error: 'private error',
    }],
  }).arms;
  const serialized = JSON.stringify(comparison) + JSON.stringify([invalid, bounded]);
  for (const privateValue of [
    'C:/private/archive.zip', 'C:/private/archive/entry.bin', 'C:/private/path',
    'C:/private/invalid-arm', 'C:/private/sink', 'private filesystem error', 'private error',
  ]) assert.equal(serialized.includes(privateValue), false);

  assert.equal(invalid.arm, 'unknown');
  assert.equal(invalid.sink, 'unknown');
  assert.equal(invalid.batchBytes, null);
  assert.equal(bounded.arm, 'memory-discard');
  assert.equal(bounded.sink, 'count-discard');
  assert.equal(bounded.batchBytes, 256 * 1024);
  assert.deepEqual({
    wallMs: bounded.wallMs, cpuUserMs: bounded.cpuUserMs, cpuSystemMs: bounded.cpuSystemMs,
    decodedBytes: bounded.decodedBytes, sinkBytesProcessed: bounded.sinkBytesProcessed,
    sinkWritableLength: bounded.sinkWritableLength, sinkNeedDrain: bounded.sinkNeedDrain,
    writeCallbackWaitMs: bounded.writeCallbackWaitMs, cleanupStatus: bounded.cleanupStatus,
    countersMatch: bounded.countersMatch,
  }, {
    wallMs: null, cpuUserMs: null, cpuSystemMs: null, decodedBytes: null,
    sinkBytesProcessed: null, sinkWritableLength: null, sinkNeedDrain: null,
    writeCallbackWaitMs: null, cleanupStatus: 'unknown', countersMatch: null,
  });
  assert.equal(comparison.assetMatches, true);
  assert.equal(comparison.memorySourceVerified, true);
  assert.equal(comparison.entryMatches, true);
  assert.equal(comparison.batchBytes, 256 * 1024);
  assert.deepEqual(comparison.armOrder, plan.map(({ arm }) => arm));
  assert.deepEqual(comparison.sinkOrder, plan.map(({ sink }) => sink));
  assert.equal(comparison.cacheCaveat, 'verified-buffer; filesystem-write-cache-not-reset');
  assert.equal(comparison.measurementScope, 'verified-memory-deflate-file-vs-discard');
  assert.deepEqual(comparison.arms.map(({ trial, arm, sink, batchBytes, compressedBytesRead, countersMatch, cleanupStatus }) =>
    ({ trial, arm, sink, batchBytes, compressedBytesRead, countersMatch, cleanupStatus })), plan.map(({ trial, arm, sink }) => ({
      trial, arm, sink, batchBytes: 256 * 1024, compressedBytesRead: null,
      countersMatch: true, cleanupStatus: sink === 'node-fs-file' ? 'removed' : 'not-created',
    })));
});
