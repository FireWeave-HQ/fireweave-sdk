// A sibling that reads at module scope, before the entrypoint body runs.
import { fw } from '@fireweaveai/server-sdk/start';
export const early = fw.controlPoints.getBooleanValue('new-checkout', false, { targetingKey: 'boot' });
