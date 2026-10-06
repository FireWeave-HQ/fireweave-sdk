/**
 * @fireweaveai/server-sdk/register: start FireWeave from the environment alone.
 *
 *   import '@fireweaveai/server-sdk/register';      // first import of the entrypoint
 *   node --import @fireweaveai/server-sdk/register app.js
 *   bun --preload @fireweaveai/server-sdk/register app.ts
 *
 * Use src/fireweave/start.ts instead when you pass control points or other options.
 */
import { start } from './start/index.js';

start();
