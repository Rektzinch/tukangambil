"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { attachDownloadTokens, verifyDownloadToken } = require('../lib/core');

test('signed responses authorize thumbnails and profile avatars', () => {
  const previous = process.env.DOWNLOAD_TOKEN_SECRET;
  process.env.DOWNLOAD_TOKEN_SECRET = 'unit-test-preview-signing-secret';
  try {
    const result = attachDownloadTokens({ items: [{ url: 'https://video.twimg.com/media.mp4', filename: 'media.mp4', thumb: 'https://pbs.twimg.com/media/thumb.jpg' }], profile: { avatar: 'https://pbs.twimg.com/profile_images/avatar.jpg' } });
    assert.deepEqual(verifyDownloadToken(result.items[0].thumbToken), { url: result.items[0].thumb, filename: 'preview.jpg' });
    assert.deepEqual(verifyDownloadToken(result.profile.avatarToken), { url: result.profile.avatar, filename: 'avatar.jpg' });
  } finally {
    if (previous === undefined) delete process.env.DOWNLOAD_TOKEN_SECRET;
    else process.env.DOWNLOAD_TOKEN_SECRET = previous;
  }
});
