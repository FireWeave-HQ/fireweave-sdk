/**
 * Browser build of @fireweaveai/server-sdk/start (the "browser" export
 * condition). Server keys must never reach a bundle, so every entry point
 * fails loudly and names the right package.
 */
import { FireweaveError } from '../index.js';

const serverOnly = (): FireweaveError =>
  new FireweaveError('Configuration', {
    message: '[fireweave] @fireweaveai/server-sdk/start is for server runtimes. Browser apps use @fireweaveai/web-sdk.',
  });

export function start(): void {
  throw serverOnly();
}

export function defineControlPoints<T>(controlPoints: T): T {
  return controlPoints;
}

export async function resetForTests(): Promise<void> {}

const fail = (): never => {
  throw serverOnly();
};

export const fw = Object.freeze({
  controlPoints: new Proxy({}, { get: () => fail }),
  identify: fail,
  instanceKey: fail,
  status: fail,
  client: fail,
  shutdown: fail,
});

export { SDK_VERSION, SDK_CHANNEL } from './build-info.js';
