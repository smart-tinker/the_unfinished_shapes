import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { test } from 'node:test';

test('coalesces ZIP entry chunks into bounded file writes without changing bytes', async () => {
  const { createZipWriteBatcher } = await import('../src/update-package.mjs');
  assert.equal(typeof createZipWriteBatcher, 'function');

  const chunks = Array.from({ length: 17 }, (_, index) => Buffer.alloc(16 * 1024, index));
  const writes = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      writes.push(Buffer.from(chunk));
      callback();
    },
  });
  await pipeline(Readable.from(chunks), createZipWriteBatcher(), sink);

  assert.deepEqual(writes.map(chunk => chunk.length), [256 * 1024, 16 * 1024]);
  assert.equal(Buffer.compare(Buffer.concat(writes), Buffer.concat(chunks)), 0);
});
