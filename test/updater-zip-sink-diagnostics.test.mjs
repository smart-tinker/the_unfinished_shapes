import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as diagnostics from '../scripts/updater-smoke-diagnostics.mjs';
import { Readable, Writable } from 'node:stream';

test('ZIP batch comparison reports the pinned entry and sanitized file-sink measurements', () => {
  assert.equal(typeof diagnostics.safeZipBatcherComparison, 'function');

  const comparison = diagnostics.safeZipBatcherComparison({
    assetMatches: true,
    entrySequence: 12,
    compression: 'deflate',
    entryCompressedSize: 111_522_616,
    entryUncompressedSize: 249_832_448,
    entryNonAsar: true,
    entryMatches: true,
    sink: 'wx-0600-file',
    readHighWaterMarkBytes: 256 * 1024,
    writeHighWaterMarkBytes: 16 * 1024,
    assetPath: 'C:/private/archive.zip',
    arms: [
      { trial: 1, batchBytes: 256 * 1024, outcome: 'completed', wallMs: 12_000, cpuUserMs: 8_100, cpuSystemMs: 1_200, compressedBytesRead: 111_522_616, decodedBytes: 249_832_448, sinkBytesWritten: 249_832_448, sourceReadableEnded: true, sinkWritableFinished: true, sinkClosed: true, cleanupStatus: 'removed', entryName: 'private-entry', error: 'private error' },
      { trial: 1, batchBytes: 1024 * 1024, outcome: 'time-limit', wallMs: 15_000, cpuUserMs: 4_300, cpuSystemMs: 700, compressedBytesRead: 38_000_000, decodedBytes: 80_000_000, sinkBytesWritten: 80_000_000, sourceReadableEnded: false, sinkWritableFinished: false, sinkClosed: false, cleanupStatus: 'removed' },
      { trial: 2, batchBytes: 1024 * 1024, outcome: 'time-limit', wallMs: 15_000, cpuUserMs: 4_100, cpuSystemMs: 800, compressedBytesRead: 50_000_000, decodedBytes: 100_000_000, sinkBytesWritten: 99_800_000, sourceReadableEnded: false, sinkWritableFinished: false, sinkClosed: false, cleanupStatus: 'removed' },
      { trial: 2, batchBytes: 256 * 1024, outcome: 'time-limit', wallMs: 15_000, cpuUserMs: 4_000, cpuSystemMs: 800, compressedBytesRead: 44_000_000, decodedBytes: 90_000_000, sinkBytesWritten: 90_000_000, sourceReadableEnded: false, sinkWritableFinished: false, sinkClosed: false, cleanupStatus: 'removed' },
    ],
  });

  assert.equal(comparison.assetMatches, true);
  assert.equal(comparison.entryMatches, true);
  assert.equal(comparison.entrySequence, 12);
  assert.equal(comparison.sink, 'wx-0600-file');
  assert.equal(comparison.readHighWaterMarkBytes, 256 * 1024);
  assert.equal(comparison.writeHighWaterMarkBytes, 16 * 1024);
  assert.deepEqual(comparison.batchBytesOrder, [256 * 1024, 1024 * 1024, 1024 * 1024, 256 * 1024]);
  assert.deepEqual(comparison.arms.map(({ trial, batchBytes }) => ({ trial, batchBytes })), [
    { trial: 1, batchBytes: 256 * 1024 },
    { trial: 1, batchBytes: 1024 * 1024 },
    { trial: 2, batchBytes: 1024 * 1024 },
    { trial: 2, batchBytes: 256 * 1024 },
  ]);
  assert.equal(comparison.arms[0].countersMatch, true);
  assert.equal(comparison.arms[2].countersMatch, false);
  assert.equal(comparison.arms[0].cleanupStatus, 'removed');
  assert.equal(comparison.cacheCaveat, 'batch-size-order-counterbalanced; filesystem-read-cache-not-reset');
  assert.equal(comparison.measurementScope, 'pipeline-only');
  for (const unsafe of ['C:/private', 'private-entry', 'private error']) {
    assert.equal(JSON.stringify(comparison).includes(unsafe), false);
  }

  const bounded = diagnostics.safeZipBatcherComparison({
    assetMatches: 'true',
    entrySequence: Number.MAX_SAFE_INTEGER,
    compression: 'private',
    entryCompressedSize: Number.MAX_SAFE_INTEGER,
    entryUncompressedSize: -1,
    sink: 'C:/private/sink',
    arms: [{ trial: 99, batchBytes: 'C:/private/path', outcome: 'private', cleanupStatus: 'C:/private/path', wallMs: -1, decodedBytes: 'private' }],
  });
  assert.equal(bounded.assetMatches, false);
  assert.equal(bounded.entrySequence, null);
  assert.equal(bounded.compression, 'unknown');
  assert.equal(bounded.entryCompressedSize, null);
  assert.equal(bounded.sink, 'unknown');
  assert.equal(bounded.arms[0].trial, null);
  assert.equal(bounded.arms[0].batchBytes, null);
  assert.equal(bounded.arms[0].outcome, 'unknown');
  assert.equal(bounded.arms[0].cleanupStatus, 'unknown');
  assert.equal(bounded.arms[0].wallMs, null);
  assert.equal(JSON.stringify(bounded).includes('C:/private'), false);
});

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
  for (const chunks of [productionBatcher, largerBatcher]) {
    assert.equal(chunks.reduce((total, chunk) => total + chunk.length, 0), expected.length);
    assert.deepEqual(Buffer.concat(chunks), expected);
  }
});

test('ZIP sink comparison exposes the counterbalanced sink-only measurements', () => {
  const sinks = ['count-discard', 'node-fs-file', 'node-fs-file', 'count-discard'];
  const arms = sinks.map((sink, index) => ({
    trial: index < 2 ? 1 : 2,
    sink,
    batchBytes: 256 * 1024,
    outcome: 'completed',
    wallMs: 10_000,
    cpuUserMs: 100,
    cpuSystemMs: 20,
    compressedBytesRead: 111_522_616,
    decodedBytes: 249_832_448,
    sinkBytesProcessed: 249_832_448,
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
  assert.deepEqual(comparison.sinkOrder, sinks);
  assert.deepEqual(comparison.arms.map(({ trial, sink }) => ({ trial, sink })), [
    { trial: 1, sink: 'count-discard' },
    { trial: 1, sink: 'node-fs-file' },
    { trial: 2, sink: 'node-fs-file' },
    { trial: 2, sink: 'count-discard' },
  ]);
  assert.equal(comparison.arms[0].sinkBytesProcessed, 249_832_448);
  assert.equal(comparison.arms[1].cleanupStatus, 'removed');
  assert.equal(comparison.arms[0].cleanupStatus, 'not-created');
  assert.equal(comparison.cacheCaveat, 'sink-order-counterbalanced; filesystem-read-cache-not-reset');
  assert.equal(comparison.measurementScope, 'pipeline-only');
  assert.equal(JSON.stringify(comparison).includes('C:/private'), false);
  assert.equal(JSON.stringify(comparison).includes('private filesystem error'), false);
});
