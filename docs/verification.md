# Rebrand and download reliability verification

## Automated checks

- `npm run verify`: 144 passed, 0 failed; 1 opt-in browser test skipped in the default run.
- `npm run build`: passed; static assets and local Archivo font copied to `dist/`.
- Opt-in Playwright test: passed separately on Chromium, no page errors.
- Browser widths: 320, 390, 768, 1440 px; no horizontal overflow.
- Browser flows: empty-input validation and focus, loading, result rendering, token download URL, error recovery, profile collection, preview close/focus return, pagination, ordering, profile help.
- Browser API responses are explicit test fixtures, not live-provider verification.

## Live network smoke check

Source: https://x.com/NASA/status/2040175881360941184

- `/api/extract` handler: HTTP 200, provider `fxtwitter`, two image items.
- `/api/download` handler over a local HTTP server: HTTP 200, JPEG signature verified, 703186 bytes.
- Signed download: HTTP 200 with attachment disposition.
- Signed thumbnail: HTTP 200 with inline disposition.
- Unsigned media request when signing is enabled: HTTP 401.
- Native Linux ARM64 yt-dlp binary successfully runs (`2026.08.19`).

The local HTTP server adapts Node request/response objects to the Vercel handler interface; this is not a deployed Vercel smoke test. Live provider availability can change. TikTok, Instagram, Facebook, and Threads have not been certified by live smoke tests in this change.

## Regression coverage added

Streaming completion and disconnect cancellation; rejected upstream cleanup; 206/416 range behavior; signed-mode authorization and malformed tokens; safe profile probes and retired diagnostic route; signed thumbnails/avatars; installer architecture selection; frontend initial state, URL feedback, loading and validation.
