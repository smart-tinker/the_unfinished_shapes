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
    armOrder: ['count-discard', 'file-sink'],
    cacheCaveat: 'file-sink-second-may-read-warm-source-cache',
    measurementScope: 'pipeline-only',
    arms: [
      {
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
    arms: [{ outcome: 'private', wallMs: -1, decodedBytes: 'private' }],
    privatePath: 'C:/private/archive.zip',
  });
  assert.equal(bounded.assetMatches, false);
  assert.equal(bounded.entrySequence, null);
  assert.equal(bounded.compression, 'unknown');
  assert.equal(bounded.entryCompressedSize, null);
  assert.equal(bounded.entryUncompressedSize, null);
  assert.equal(bounded.arms[0].outcome, 'unknown');
  assert.equal(bounded.arms[0].wallMs, null);
  assert.equal(bounded.arms[0].decodedBytes, null);
  assert.equal(JSON.stringify(bounded).includes('C:/private'), false);
});
