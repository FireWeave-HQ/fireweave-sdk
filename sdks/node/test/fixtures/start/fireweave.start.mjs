// The module initialise writes as src/fireweave/start.ts.
import { start } from '@fireweaveai/server-sdk/start';
import { flags } from './flags.mjs';
start({ flags });
