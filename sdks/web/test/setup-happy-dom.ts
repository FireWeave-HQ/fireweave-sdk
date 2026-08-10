/**
 * Bun test preload: install a DOM before any test module is imported.
 *
 * The web SDK guards every browser-only API it touches (`globalThis.navigator`,
 * `globalThis.addEventListener`), so the suite would *run* without a DOM — it
 * would just silently skip the code that matters. `attachUnloadFlush()` would
 * take its no-op branch, and the exposure-flush-on-unload path would be
 * "covered" by tests that never execute it.
 *
 * Registering happy-dom globally makes `window`, `document`,
 * `document.visibilityState`, and the event target real, so `pagehide` and
 * `visibilitychange` can actually be dispatched and observed.
 *
 * `navigator.sendBeacon` is NOT provided by happy-dom; tests that need it stub
 * it explicitly, which keeps the stub visible at the call site instead of
 * hidden in this file.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register({ url: 'https://app.example.test/' });
