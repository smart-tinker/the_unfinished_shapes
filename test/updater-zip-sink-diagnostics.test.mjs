import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as diagnostics from '../scripts/updater-smoke-diagnostics.mjs';
import { Readable, Writable } from 'node:stream';

test('ZIP sink comparison reports the pinned entry and sanitized paired results', () => {
  assert.equal(typeof diagnostics.safeZipSinkComparison, 'function');

  const comparison = diagnostics.safeZipSinkComparison({
    assetMatches: true,
    entrySequence: 12,
    compression: 'deflate',
    entryCompressedSize: 111_522_616,
    entryUncompressedSize: 249_832_448,
    entryNonAsar: true,
    entryMatches: true,
    assetPath: 'C:/private/archive.zip',
    arms: [
      { trial: 1, sink: 'count-discard', outcome: 'completed', wallMs: 12_000, cpuUserMs: 8_100, cpuSystemMs: 1_200, compressedBytesRead: 111_522_616, decodedBytes: 249_832_448, sinkBytesWritten: 249_832_448, sourceReadableEnded: true, sinkWritableFinished: true, sinkClosed: true, entryName: 'private-entry', error: 'private error' },
      { trial: 1, sink: 'file-sink', outcome: 'time-limit', wallMs: 15_000, cpuUserMs: 4_300, cpuSystemMs: 700, compressedBytesRead: 38_000_000, decodedBytes: 80_000_000, sinkBytesWritten: 80_000_000, sourceReadableEnded: false, sinkWritableFinished: false, sinkClosed: false },
      { trial: 2, sink: 'file-sink', outcome: 'time-limit', wallMs: 15_000, cpuUserMs: 4_100, cpuSystemMs: 800, compressedBytesRead: 50_000_000, decodedBytes: 100_000_000, sinkBytesWritten: 99_800_000, sourceReadableEnded: false, sinkWritableFinished: false, sinkClosed: false },
      { trial: 2, sink: 'count-discard', outcome: 'time-limit', wallMs: 15_000, cpuUserMs: 4_000, cpuSystemMs: 800, compressedBytesRead: 44_000_000, decodedBytes: 90_000_000, sinkBytesWritten: 90_000_000, sourceReadableEnded: false, sinkWritableFinished: false, sinkClosed: false },
    ],
  });

  assert.equal(comparison.assetMatches, true);
  assert.equal(comparison.entryMatches, true);
  assert.equal(comparison.entrySequence, 12);
  assert.deepEqual(comparison.armOrder, ['count-discard', 'file-sink', 'file-sink', 'count-discard']);
  assert.deepEqual(comparison.arms.map(({ trial, sink }) => ({ trial, sink })), [
    { trial: 1, sink: 'count-discard' },
    { trial: 1, sink: 'file-sink' },
    { trial: 2, sink: 'file-sink' },
    { trial: 2, sink: 'count-discard' },
  ]);
  assert.equal(comparison.arms[0].countersMatch, true);
  assert.equal(comparison.arms[2].countersMatch, false);
  assert.equal(comparison.cacheCaveat, 'sink-order-counterbalanced; filesystem-read-cache-not-reset');
  assert.equal(comparison.measurementScope, 'pipeline-only');
  assert.doesNotMatch(JSON.stringify(comparison), /C:\/private|private-entry|private error/);

  const bounded = diagnostics.safeZipSinkComparison({
    assetMatches: 'true',
    entrySequence: Number.MAX_SAFE_INTEGER,
    compression: 'private',
    entryCompressedSize: Number.MAX_SAFE_INTEGER,
    entryUncompressedSize: -1,
    arms: [{ trial: 99, sink: 'C:/private/path', outcome: 'private', wallMs: -1, decodedBytes: 'private' }],
  });
  assert.equal(bounded.assetMatches, false);
  assert.equal(bounded.entrySequence, null);
  assert.equal(bounded.compression, 'unknown');
  assert.equal(bounded.entryCompressedSize, null);
  assert.equal(bounded.arms[0].trial, null);
  assert.equal(bounded.arms[0].sink, 'unknown');
  assert.equal(bounded.arms[0].outcome, 'unknown');
  assert.equal(bounded.arms[0].wallMs, null);
  assert.doesNotMatch(JSON.stringify(bounded), /C:\/private/);
});


test('ZIP pipeline diagnostic selects the production batcher or direct stream without changing bytes', async () => {
  assert.equal(typeof diagnostics.runZipSinkPipeline, 'function');

  const input = [
    Buffer.alloc(160 * 1024, 0x31),
    Buffer.alloc(160 * 1024, 0x62),
  ];
  const expected = Buffer.concat(input);
  const collect = async mode => {
    const chunks = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    await diagnostics.runZipSinkPipeline(Readable.from(input), sink, mode);
    return chunks;
  };

  const productionBatcher = await collect('production-batcher');
  const directStream = await collect('direct-stream');
  assert.deepEqual(productionBatcher.map(chunk => chunk.length), [256 * 1024, 64 * 1024]);
  assert.deepEqual(directStream.map(chunk => chunk.length), [160 * 1024, 160 * 1024]);
  for (const chunks of [productionBatcher, directStream]) {
    assert.equal(chunks.reduce((total, chunk) => total + chunk.length, 0), expected.length);
    assert.deepEqual(Buffer.concat(chunks), expected);
  }
});
