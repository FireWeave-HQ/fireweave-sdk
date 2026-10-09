// The module initialise writes as src/fireweave/start.ts.
import { start } from '@fireweaveai/server-sdk/start';
import { controlPoints } from './control-points.mjs';
start({ controlPoints });
