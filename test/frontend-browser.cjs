"use strict";
// Run after npm run build with a static server on FRONTEND_URL (default :4173).
// PLAYWRIGHT_MODULE and CHROME_PATH allow using an existing browser installation.
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const screenshotDir = process.env.SCREENSHOT_DIR || require('node:os').tmpdir();
const screenshotPath = name => path.join(screenshotDir, name);
test('opt-in real browser frontend flow', { skip: !process.env.PLAYWRIGHT_MODULE }, async () => {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let scenario = 'single';
  const image = { type: 'image', url: 'https://example.test/image.jpg', filename: 'contoh.jpg', quality: 'Asli', downloadToken: 'test-token' };
  await page.route('**/api/download?**', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500"><rect width="400" height="500" fill="#c7baa5"/><text x="25" y="250" font-size="30">MEDIA UJI</text></svg>' }));
  await page.route('**/api/extract', async route => {
    await new Promise(resolve => setTimeout(resolve, 150));
    if (scenario === 'error') return route.fulfill({ status: 502, json: { error: 'Provider unavailable' } });
    return route.fulfill({ json: { platform: 'instagram', title: 'Contoh media publik', author: 'akun_uji', items: [image] } });
  });
  await page.route('**/api/profile', route => {
    const body = route.request().postDataJSON();
    const offset = body.offset || 0;
    return route.fulfill({ json: { platform: 'tiktok', title: 'Koleksi pengujian', resourceKind: 'profile', profile: { username: 'uji', nickname: 'Akun Uji', mediaCount: 3 }, items: offset ? [{ ...image, id: 'three', filename: 'ketiga.jpg' }] : [{ ...image, id: 'one' }, { ...image, id: 'two', filename: 'kedua.jpg' }], pagination: { offset, hasMore: !offset, order: body.order || 'newest' } } });
  });
  try {
    fs.mkdirSync(screenshotDir, { recursive: true });
    await page.goto(process.env.FRONTEND_URL || 'http://127.0.0.1:4173');
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('#profileNotice').evaluate(el => el.open), false);
    await page.screenshot({ path: screenshotPath('tukangambil-desktop.png'), fullPage: true });
    await page.locator('.submit').click();
    assert.equal(await page.locator('#mediaUrl').getAttribute('aria-invalid'), 'true');
    assert.equal(await page.locator('#mediaUrl').evaluate(el => el === document.activeElement), true);
    await page.locator('#mediaUrl').fill('https://instagram.com/p/test');
    await page.locator('.submit').click();
    await page.locator('#scan:not([hidden])').waitFor();
    assert.equal(await page.locator('#scanProgressTrack').getAttribute('aria-valuenow'), null);
    await page.locator('#results:not([hidden]) .download').waitFor();
    assert.match(await page.locator('.download').getAttribute('href'), /token=test-token/);
    await page.screenshot({ path: screenshotPath('tukangambil-result.png'), fullPage: true });
    scenario = 'error';
    await page.locator('.submit').click();
    await page.locator('#message.error').waitFor();
    assert.equal(await page.locator('.submit').isEnabled(), true);
    await page.locator('[data-mode="profile"]').click();
    await page.locator('#mediaUrl').fill('https://tiktok.com/@uji');
    await page.locator('.submit').click();
    await page.locator('.tile').first().waitFor();
    assert.equal(await page.locator('.tile').count(), 2);
    await page.locator('.preview-btn').first().click();
    await page.locator('.modal:not([hidden])').waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.preview-btn').first().evaluate(el => el === document.activeElement), true);
    await page.locator('.load-more').click();
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 3);
    await page.locator('[data-order="oldest"]').click();
    await page.waitForFunction(() => document.querySelector('[data-order="oldest"]').getAttribute('aria-pressed') === 'true');
    await page.locator('#profileInfo').click();
    await page.locator('[data-close-profile-notice]').first().click();
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow at ${width}px`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: screenshotPath('tukangambil-mobile-results.png'), fullPage: true });
    await page.reload();
    await page.evaluate(() => document.activeElement?.blur());
    await page.screenshot({ path: screenshotPath('tukangambil-mobile.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log('PASS: desktop/mobile layout (320/390/768/1440), validation/focus, loading, extraction, token download link, server error recovery, profile collection, preview/Escape focus return, pagination, ordering, profile help. No page errors. API fixtures used; not a live-provider download test.');
  } finally { await browser.close(); }
});
