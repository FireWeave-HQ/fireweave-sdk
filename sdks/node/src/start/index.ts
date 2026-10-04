/**
 * @fireweaveai/server-sdk/start: FireWeave in one import (docs/adr/0012-start-profile.md).
 *
 *   // src/fireweave/start.ts  (imported first by your entrypoint)
 *   import { start } from '@fireweaveai/server-sdk/start';
 *   import { flags } from './flags';
 *   start({ flags });
 *
 *   // anywhere
 *   import { fw } from '@fireweaveai/server-sdk/start';
 *   if (await fw.controlPoints.getBooleanValue('new-checkout', false, { targetingKey: user.id })) { … }
 *
 * This layer is built only on the package's public exports; the core
 * (initFireweave and everything in '.') is unchanged and still reads no env.
 */
export { start, resetForTests } from './state.js';
export type { StartOptions, StartState, FireweaveStatus } from './state.js';
export { fw } from './fw.js';
export type { FireweaveStart, ControlPoints, IdentifyOptions } from './fw.js';
export { defineFlags } from './flags.js';
export type { FlagDefinition, FlagMap } from './flags.js';
export type { StartMode, SdkChannel } from './resolve.js';
export { SDK_VERSION, SDK_CHANNEL } from './build-info.js';
