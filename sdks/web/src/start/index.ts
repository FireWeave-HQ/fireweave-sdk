/**
 * @fireweaveai/web-sdk/start: one start() call for a browser app.
 *
 * ```ts
 * // src/fireweave/control-points.ts
 * import { defineControlPoints } from '@fireweaveai/web-sdk/start';
 * export const controlPoints = defineControlPoints({ 'new-checkout': { local: true } });
 *
 * // src/fireweave/start.ts — the first import of your entry module
 * import { start } from '@fireweaveai/web-sdk/start';
 * import { controlPoints } from './control-points';
 * export const ready = start({ controlPoints });
 *
 * // anywhere
 * import { fw } from '@fireweaveai/web-sdk/start';
 * if (fw.controlPoints.getBooleanValue('new-checkout', false)) { ... }
 * ```
 *
 * The key, endpoint and environment come from the fireweave() Vite plugin
 * (`@fireweaveai/web-sdk/vite`) or fireweaveDefine() (`/define`) at build
 * time, or from start() options. This module reads no environment.
 *
 * A layer over the unchanged core: it imports only the public barrel
 * (docs/adr/0012-start-profile.md).
 */
export { start, resetForTests } from './state.js';
export type { StartOptions, StartState, StartProblem, FireweaveWebStatus } from './state.js';
export { fw } from './fw.js';
export type { FireweaveWebStart, ControlPoints, IdentifyOptions } from './fw.js';
export { defineControlPoints } from './control-points.js';
export type { ControlPointDefinition, ControlPointMap } from './control-points.js';
export type { Persistence } from './identity.js';
export type { StartMode, SdkChannel } from './policy.js';
export { SDK_VERSION, SDK_CHANNEL } from './build-info.js';
