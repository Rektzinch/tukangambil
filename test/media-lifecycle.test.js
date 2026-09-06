const test = require('node:test');
const assert = require('node:assert/strict');
const extract = require('../api/extract');
const profile = require('../api/profile');
const { fetchAllowedMedia } = require('../lib/media-policy');

test('extract and profile probes cancel bodies after checking status', async t => {
  let cancelled = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': 'video/mp4' } }));
  assert.equal(await extract.probeDownloadable('https://video.twimg.com/a.mp4'), true);
  assert.equal(await profile.probeDownloadable('https://video.twimg.com/a.mp4'), true);
  assert.equal(cancelled, 2);
});

test('redirect response bodies are cancelled before following or rejecting targets', async t => {
  let cancelled = 0; let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 302, headers: { location: 'http://127.0.0.1/internal' } });
  });
  await assert.rejects(fetchAllowedMedia('https://video.twimg.com/a.mp4'), /Host media/);
  assert.equal(calls, 1);
  assert.equal(cancelled, 1);
});

test('profile probe rejects unallowlisted URLs without a request', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('secret'); });
  assert.equal(await profile.probeDownloadable('http://127.0.0.1/internal'), false);
  assert.equal(calls, 0);
});
