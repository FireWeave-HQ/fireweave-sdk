// The polyfill docs/module-formats.md tells Jest + jsdom users to add to setupFiles.
globalThis.TextEncoder ??= require('node:util').TextEncoder;
