import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as diagnostics from '../scripts/updater-smoke-diagnostics.mjs';

test('safe ZIP sink comparison reports bounded counters for both sinks without private details', () => {
  const raw = {
    assetMatches: true,
    entrySequence: 12,
    compression: 'deflate',
    entryCompressedSize: 111_522_616,
    entryUncompressedSize: 249_832_448,
    entryNonAsar: true,
    entryMatches: true,
    arms: [
      {
        trial: 1,
        sink: 'count-discard',
        outcome: 'completed',
        wallMs: 12_000,
        cpuUserMs: 8_100,
        cpuSystemMs: 1_200,
        compressedBytesRead: 111_522_616,
        decodedBytes: 249_832_448,
        sinkBytesWritten: 249_832_448,
        sourceReadableEnded: true,
        sinkWritableFinished: true,
        sinkClosed: true,
        privatePath: 'C:/private/archive.zip',
        privateError: 'raw filesystem error',
      },
      {
        trial: 1,
        sink: 'file-sink',
        outcome: 'time-limit',
        wallMs: 15_000,
        cpuUserMs: 4_300,
        cpuSystemMs: 700,
        compressedBytesRead: 38_000_000,
        decodedBytes: 80_000_000,
        sinkBytesWritten: 80_000_000,
        sourceReadableEnded: false,
        sinkWritableFinished: false,
        sinkClosed: false,
        privatePath: 'C:/private/entry',
        privateError: 'raw stream error',
      },
      {
        trial: 2,
        sink: 'file-sink',
        outcome: 'time-limit',
        wallMs: 15_000,
        cpuUserMs: 4_100,
        cpuSystemMs: 800,
        compressedBytesRead: 50_000_000,
        decodedBytes: 100_000_000,
        sinkBytesWritten: 99_800_000,
        sourceReadableEnded: false,
        sinkWritableFinished: false,
        sinkClosed: false,
        privatePath: 'C:/private/entry-two',
        privateError: 'raw stream error two',
      },
      {
        trial: 2,
        sink: 'count-discard',
        outcome: 'time-limit',
        wallMs: 15_000,
        cpuUserMs: 4_000,
        cpuSystemMs: 800,
        compressedBytesRead: 44_000_000,
        decodedBytes: 90_000_000,
        sinkBytesWritten: 90_000_000,
        sourceReadableEnded: false,
        sinkWritableFinished: false,
        sinkClosed: false,
      },
    ],
    assetPath: 'C:/private/download.zip',
  };

  const comparison = typeof diagnostics.safeZipSinkComparison === 'function'
    ? diagnostics.safeZipSinkComparison(raw)
    : undefined;

  assert.deepEqual(comparison, {
    assetMatches: true,
    entrySequence: 12,
    compression: 'deflate',
    entryCompressedSize: 111_522_616,
    entryUncompressedSize: 249_832_448,
    entryNonAsar: true,
    entryMatches: true,
    armOrder: ['count-discard', 'file-sink', 'file-sink', 'count-discard'],
    cacheCaveat: 'sink-order-counterbalanced; filesystem-read-cache-not-reset',
    measurementScope: 'pipeline-only',
    arms: [
      {
        trial: 1,
        sink: 'count-discard',
        outcome: 'completed',
        wallMs: 12_000,
        cpuUserMs: 8_100,
        cpuSystemMs: 1_200,
        compressedBytesRead: 111_522_616,
        decodedBytes: 249_832_448,
        sinkBytesWritten: 249_832_448,
        countersMatch: true,
        sourceReadableEnded: true,
        sinkWritableFinished: true,
        sinkClosed: true,
      },
      {
        trial: 1,
        sink: 'file-sink',
        outcome: 'time-limit',
        wallMs: 15_000,
        cpuUserMs: 4_300,
        cpuSystemMs: 700,
        compressedBytesRead: 38_000_000,
        decodedBytes: 80_000_000,
        sinkBytesWritten: 80_000_000,
        countersMatch: true,
        sourceReadableEnded: false,
        sinkWritableFinished: false,
        sinkClosed: false,
      },
      {
        trial: 2,
        sink: 'file-sink',
        outcome: 'time-limit',
        wallMs: 15_000,
        cpuUserMs: 4_100,
        cpuSystemMs: 800,
        compressedBytesRead: 50_000_000,
        decodedBytes: 100_000_000,
        sinkBytesWritten: 99_800_000,
        countersMatch: false,
        sourceReadableEnded: false,
        sinkWritableFinished: false,
        sinkClosed: false,
      },
      {
        trial: 2,
        sink: 'count-discard',
        outcome: 'time-limit',
        wallMs: 15_000,
        cpuUserMs: 4_000,
        cpuSystemMs: 800,
        compressedBytesRead: 44_000_000,
        decodedBytes: 90_000_000,
        sinkBytesWritten: 90_000_000,
        countersMatch: true,
        sourceReadableEnded: false,
        sinkWritableFinished: false,
        sinkClosed: false,
      },
    ],
  });
  const serialized = JSON.stringify(comparison);
  assert.equal(serialized.includes('C:/private'), false);
  assert.equal(serialized.includes('raw filesystem error'), false);
  assert.equal(serialized.includes('raw stream error'), false);

  const bounded = diagnostics.safeZipSinkComparison({
    assetMatches: 'true',
    entrySequence: Number.MAX_SAFE_INTEGER,
    compression: 'private',
    entryCompressedSize: Number.MAX_SAFE_INTEGER,
    entryUncompressedSize: -1,
    arms: [{ trial: 99, sink: 'C:/private/sink', outcome: 'private', wallMs: -1, decodedBytes: 'private' }],
    privatePath: 'C:/private/archive.zip',
  });
  assert.equal(bounded.assetMatches, false);
  assert.equal(bounded.entrySequence, null);
  assert.equal(bounded.compression, 'unknown');
  assert.equal(bounded.entryCompressedSize, null);
  assert.equal(bounded.entryUncompressedSize, null);
  assert.equal(bounded.arms[0].trial, null);
  assert.equal(bounded.arms[0].sink, 'unknown');
  assert.equal(bounded.arms[0].outcome, 'unknown');
  assert.equal(bounded.arms[0].wallMs, null);
  assert.equal(bounded.arms[0].decodedBytes, null);
  assert.equal(JSON.stringify(bounded).includes('C:/private'), false);
});

test('ZIP sink comparison reports both counterbalanced trials in actual order', () => {
  const comparison = typeof diagnostics.safeZipSinkComparison === 'function'
    ? diagnostics.safeZipSinkComparison({
        assetMatches: true,
        entrySequence: 12,
        compression: 'deflate',
        entryCompressedSize: 111_522_616,
        entryUncompressedSize: 249_832_448,
        entryNonAsar: true,
        entryMatches: true,
        arms: [
          { trial: 1, sink: 'count-discard', outcome: 'time-limit', wallMs: 15_000, cpuUserMs: 300, cpuSystemMs: 400, compressedBytesRead: 10_000_000, decodedBytes: 20_000_000, sinkBytesWritten: 19_900_000 },
          { trial: 1, sink: 'file-sink', outcome: 'time-limit', wallMs: 15_000, cpuUserMs: 500, cpuSystemMs: 300, compressedBytesRead: 12_000_000, decodedBytes: 24_000_000, sinkBytesWritten: 23_900_000 },
          { trial: 2, sink: 'file-sink', outcome: 'time-limit', wallMs: 15_000, cpuUserMs: 400, cpuSystemMs: 300, compressedBytesRead: 13_000_000, decodedBytes: 26_000_000, sinkBytesWritten: 25_900_000 },
          { trial: 2, sink: 'count-discard', outcome: 'time-limit', wallMs: 15_000, cpuUserMs: 300, cpuSystemMs: 400, compressedBytesRead: 11_000_000, decodedBytes: 22_000_000, sinkBytesWritten: 21_900_000 },
        ],
      })
    : undefined;

  assert.equal(comparison.entryMatches, true);
  assert.deepEqual(comparison.armOrder, ['count-discard', 'file-sink', 'file-sink', 'count-discard']);
  assert.deepEqual(comparison.arms.map(({ trial, sink }) => ({ trial, sink })), [
    { trial: 1, sink: 'count-discard' },
    { trial: 1, sink: 'file-sink' },
    { trial: 2, sink: 'file-sink' },
    { trial: 2, sink: 'count-discard' },
  ]);
  assert.equal(comparison.arms.length, 4);
});
