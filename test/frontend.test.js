"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function boot() {
  const elements = new Map();
  function element(key) {
    if (elements.has(key)) return elements.get(key);
    const el = { value: '', textContent: '', innerHTML: '', hidden: true, disabled: false,
      dataset: {}, style: { setProperty() {} }, attrs: {}, listeners: {},
      classList: { add() {}, remove() {}, toggle() {} },
      querySelector: selector => element(`${key} ${selector}`), querySelectorAll: () => [],
      setAttribute(k,v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
      hasAttribute(k) { return k in this.attrs; }, addEventListener(k,fn) { this.listeners[k] = fn; },
      focus() { document.activeElement = this; }, scrollIntoView() {},
      showModal() { this.attrs.open = ''; }, close() { delete this.attrs.open; }
    };
    elements.set(key,el); return el;
  }
  const document = { documentElement: element('html'), body: element('body'), activeElement: null,
    querySelector: element, querySelectorAll: () => [], addEventListener() {} };
  const context = vm.createContext({ document, window: {}, navigator: {}, localStorage: { getItem: () => null, setItem() {} },
    URL, URLSearchParams, Intl, AbortController, console, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {} });
  vm.runInContext(fs.readFileSync(require.resolve('../public/app.js'), 'utf8'), context);
  return { context, element, document, run: expression => vm.runInContext(expression, context) };
}

test('first visit leaves the input accessible without an unsolicited profile dialog', () => {
  const ui = boot();
  assert.equal(ui.element('#profileNotice').hasAttribute('open'), false);
});

test('lookalike domains are not presented as supported platforms', () => {
  const ui = boot();
  assert.equal(ui.run('platformFromUrl("https://notinstagram.com/p/123")'), '');
  assert.equal(ui.run('platformFromUrl("https://instagram.com.evil.example/p/123")'), '');
  assert.equal(ui.run('platformFromUrl("https://m.facebook.com/watch/123")'), 'Facebook');
});

test('empty submit identifies the invalid field and moves focus to it', async () => {
  const ui = boot();
  await ui.element('#downloadForm').listeners.submit({ preventDefault() {} });
  assert.equal(ui.element('#mediaUrl').attrs['aria-invalid'], 'true');
  assert.equal(ui.document.activeElement, ui.element('#mediaUrl'));
});

test('loading reports indeterminate progress instead of fabricated percentage', () => {
  const ui = boot();
  ui.run('start()');
  assert.equal(ui.element('#scanProgressTrack').attrs['aria-valuenow'], undefined);
  assert.equal(ui.element('#scanLabel').textContent, 'Menghubungi sumber');
  ui.run('stop()');
  assert.equal(ui.element('#downloadForm .submit span').textContent, 'Ambil dan periksa');
});

test('editing a rejected link clears its stale invalid state', () => {
  const ui = boot();
  ui.element('#mediaUrl').setAttribute('aria-invalid', 'true');
  ui.element('#mediaUrl').listeners.input();
  assert.equal(ui.element('#mediaUrl').hasAttribute('aria-invalid'), false);
});

test('thumbnail and avatar proxy URLs prefer signed tokens', () => {
  const ui = boot();
  const thumb = new URL(ui.run('thumbUrl({thumb: "https://pbs.twimg.com/t.jpg", thumbToken: "signed-thumb"})'), 'https://app.test');
  const avatar = new URL(ui.run('avatarUrl({avatar: "https://pbs.twimg.com/a.jpg", avatarToken: "signed-avatar"})'), 'https://app.test');
  assert.equal(thumb.searchParams.get('token'), 'signed-thumb');
  assert.equal(avatar.searchParams.get('token'), 'signed-avatar');
  assert.equal(thumb.searchParams.has('url'), false);
  assert.equal(avatar.searchParams.has('url'), false);
});

test('favicon is self-hosted for the production self-only image CSP', () => {
  const html = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
  assert.match(html, /rel="icon" href="\/favicon\.svg"/);
});

module.exports = { boot };
