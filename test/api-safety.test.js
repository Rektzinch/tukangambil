const test = require('node:test');
const assert = require('node:assert/strict');
const probe = require('../api/probe');
const core = require('../lib/core');

test('signed tokens reject trailing segments and noncanonical signatures', t => {
  const old = process.env.DOWNLOAD_TOKEN_SECRET;
  process.env.DOWNLOAD_TOKEN_SECRET = 'test-secret';
  t.after(() => { if (old === undefined) delete process.env.DOWNLOAD_TOKEN_SECRET; else process.env.DOWNLOAD_TOKEN_SECRET = old; });
  const token = core.signDownloadToken({ url: 'https://video.twimg.com/a.mp4', filename: 'a.mp4' });
  assert.ok(core.verifyDownloadToken(token));
  assert.equal(core.verifyDownloadToken(token + '.ignored'), null);
  assert.equal(core.verifyDownloadToken(token + '!'), null);
});

test('tokens expire at the exact expiry second', t => {
  const old = process.env.DOWNLOAD_TOKEN_SECRET;
  process.env.DOWNLOAD_TOKEN_SECRET = 'test-secret';
  t.after(() => { if (old === undefined) delete process.env.DOWNLOAD_TOKEN_SECRET; else process.env.DOWNLOAD_TOKEN_SECRET = old; });
  t.mock.method(Date, 'now', () => 1800000000000);
  const token = core.signDownloadToken({ url: 'https://video.twimg.com/a.mp4', filename: 'a.mp4' }, 0);
  assert.equal(core.verifyDownloadToken(token), null);
});

test('temporary probe route is disabled and never fetches caller URLs', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('internal secret'); });
  const res = { setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await probe({ method: 'GET', query: { url: 'http://169.254.169.254/latest/meta-data/' } }, res);
  assert.equal(calls, 0);
  assert.equal(res.statusCode, 404);
});
