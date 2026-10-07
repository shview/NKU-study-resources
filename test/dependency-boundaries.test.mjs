import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { loadRemoteImage, revalidateRemoteImage } from '../node_modules/astro/dist/assets/build/remote.js';

const require = createRequire(import.meta.url);
const { SourceMapConsumer } = require('source-map-js');
const basic = () => ({ version: 3, sources: ['source.js'], names: [], mappings: 'AAAA', sourcesContent: ['x'] });
const indexed = (line, map = basic()) => ({ version: 3, sections: [{ offset: { line, column: 0 }, map }] });

test('source map offsets reject invalid input before mapping expansion', () => {
  // Constructors only: bounded input, no large allocation or resource-exhaustion test.
  for (const line of [-1, 0.5, '1', null, Infinity, NaN, 10_000_001]) {
    assert.throws(() => new SourceMapConsumer(indexed(line)), `invalid line ${String(line)}`);
  }
  assert.throws(() => new SourceMapConsumer(indexed(6_000_000, indexed(6_000_000))), 'nested offsets cannot exceed the supported total');
});

test('basic and ordinary indexed source maps retain original-position lookup', () => {
  const direct = new SourceMapConsumer(basic());
  assert.deepEqual(direct.originalPositionFor({ line: 1, column: 0 }), { source: 'source.js', line: 1, column: 0, name: null });
  const nested = new SourceMapConsumer(indexed(2, indexed(1)));
  assert.deepEqual(nested.sources, ['source.js']);
  assert.deepEqual(nested.originalPositionFor({ line: 4, column: 1 }), { source: 'source.js', line: 1, column: 0, name: null });
  assert.equal(nested.sourceContentFor('source.js'), 'x');
});

test('Astro remote image load and conditional revalidation retain TTL and byte semantics', async () => {
  const url = 'https://images.example.test/fixture.png';
  const config = { domains: ['images.example.test'], remotePatterns: [] };
  const before = Date.now();
  const first = await loadRemoteImage(url, async () => new Response('synthetic-image-bytes', {
    status: 200, headers: { 'cache-control': 'public, max-age=60', etag: 'synthetic-etag' },
  }), config);
  assert.equal(first.data.toString(), 'synthetic-image-bytes');
  assert.equal(first.etag, 'synthetic-etag');
  assert.ok(first.expires >= before + 50_000 && first.expires <= Date.now() + 61_000);
  const again = await revalidateRemoteImage(url, first, async (request) => {
    assert.equal(request.headers.get('if-none-match'), 'synthetic-etag');
    return new Response(null, { status: 304, headers: { 'cache-control': 'public, max-age=60' } });
  }, config);
  assert.equal(again.data, null);
  assert.equal(again.etag, 'synthetic-etag');
  const uncached = await loadRemoteImage(url, async () => new Response('no-store', { headers: { 'cache-control': 'no-store' } }), config);
  assert.ok(uncached.expires <= Date.now());
});
