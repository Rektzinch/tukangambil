const test = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');
const { EventEmitter } = require('node:events');
const download = require('../api/download');

test('configured signing secret disallows unsigned same-origin URL fallback', async t => {
  const old = process.env.DOWNLOAD_TOKEN_SECRET;
  process.env.DOWNLOAD_TOKEN_SECRET = 'test-secret';
  t.after(() => { if (old === undefined) delete process.env.DOWNLOAD_TOKEN_SECRET; else process.env.DOWNLOAD_TOKEN_SECRET = old; });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(null, { status: 500 }); });
  const res = response();
  await download(request(), res);
  assert.equal(res.statusCode, 401);
  assert.equal(calls, 0);
});

function request() {
  return Object.assign(new EventEmitter(), { method: 'GET', headers: { host: 'app.example', origin: 'https://app.example', 'sec-fetch-site': 'same-origin' }, query: { url: 'https://video.twimg.com/demo.mp4', filename: 'demo.mp4' }, socket: { remoteAddress: '192.0.2.80' } });
}
function response() {
  const res = new Writable({ write(chunk, encoding, cb) { this.headersSent = true; this.chunks.push(chunk); cb(); } });
  res.chunks = []; res.headers = {};
  res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; };
  res.removeHeader = name => { delete res.headers[name.toLowerCase()]; };
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; res.end(JSON.stringify(body)); return res; };
  res.on('error', () => {});
  return res;
}

test('download handler remains pending until upstream and response finish', async t => {
  let controller;
  const body = new ReadableStream({ start(value) { controller = value; } });
  t.mock.method(globalThis, 'fetch', async () => new Response(body, { headers: { 'content-type': 'video/mp4' } }));
  const res = response(); let settled = false;
  const running = download(request(), res).then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  const early = settled;
  controller.enqueue(new Uint8Array([1, 2, 3])); controller.close();
  await running;
  assert.equal(early, false);
  assert.equal(res.writableFinished, true);
});

test('upstream 416 preserves unsatisfied Content-Range and cancels error body', async t => {
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 416, headers: { 'content-range': 'bytes */123', 'content-type': 'text/html' } }));
  const req = request(); req.headers.range = 'bytes=200-';
  const res = response();
  await download(req, res);
  assert.equal(res.statusCode, 416);
  assert.equal(res.headers['content-range'], 'bytes */123');
  assert.equal(cancelled, true);
});

test('partial upstream response without Content-Range is rejected before streaming', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('abc', { status: 206, headers: { 'content-type': 'video/mp4' } }));
  const req = request(); req.headers.range = 'bytes=0-2';
  const res = response();
  await download(req, res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.headers['content-disposition'], undefined);
});

test('rejected non-media upstream body is cancelled', async t => {
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/html' } }));
  const res = response();
  await download(request(), res);
  assert.equal(res.statusCode, 502);
  assert.equal(cancelled, true);
});

test('client disconnect while awaiting upstream aborts fetch', async t => {
  let signal; let release;
  t.mock.method(globalThis, 'fetch', (_url, options) => { signal = options.signal; return new Promise(resolve => { release = resolve; }); });
  const req = request(); const res = response();
  const running = download(req, res);
  await new Promise(resolve => setImmediate(resolve));
  res.destroy();
  await new Promise(resolve => setImmediate(resolve));
  const aborted = signal.aborted;
  release(new Response(null, { status: 500 }));
  await running;
  assert.equal(aborted, true);
});
