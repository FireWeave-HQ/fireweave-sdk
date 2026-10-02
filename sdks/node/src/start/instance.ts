/**
 * fw.instanceKey(): a stable targeting key for reads where the server itself is
 * the subject (cron, migrations, boot-time decisions). Request reads still pass
 * the user's id.
 *
 * Sources, in order: start({ instanceId }), FIREWEAVE_INSTANCE_ID, then a hash
 * of the host name, then a random id for the life of the process. Nothing is
 * written to disk: in a container the file would not outlive the process anyway.
 */
import type { EnvReader } from './env.js';
import { quiet } from './env.js';
import { ENV } from './names.js';

export interface InstanceKey {
  readonly value: string;
  readonly source: 'option' | 'FIREWEAVE_INSTANCE_ID' | 'host' | 'random';
}

/** FNV-1a 64-bit, hex. Stable across runtimes; not a security hash. */
export function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

interface ProcessLike {
  getBuiltinModule?: (id: string) => { hostname?: () => string } | undefined;
}
interface DenoLike {
  hostname?: () => string;
}

/** Host name without importing a runtime module; undefined when the runtime will not say. */
function hostName(read: EnvReader): string | undefined {
  const fromEnv = quiet(read)('HOSTNAME');
  if (fromEnv !== undefined) return fromEnv;
  try {
    const deno = (globalThis as { Deno?: DenoLike }).Deno;
    if (typeof deno?.hostname === 'function') return deno.hostname();
  } catch {
    // Deno without --allow-sys=hostname: fall through.
  }
  try {
    const proc = (globalThis as { process?: ProcessLike }).process;
    const os = proc?.getBuiltinModule?.('node:os');
    const name = os?.hostname?.();
    if (typeof name === 'string' && name !== '') return name;
  } catch {
    // Runtime without getBuiltinModule: fall through.
  }
  return undefined;
}

const randomId = (): string => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
};

export function deriveInstanceKey(option: string | undefined, read: EnvReader): InstanceKey {
  if (option !== undefined) return { value: option, source: 'option' };
  const fromEnv = quiet(read)(ENV.instanceId);
  if (fromEnv !== undefined) return { value: fromEnv, source: 'FIREWEAVE_INSTANCE_ID' };
  const host = hostName(read);
  if (host !== undefined) return { value: `inst_${fnv1a64(host)}`, source: 'host' };
  return { value: `inst_${randomId()}`, source: 'random' };
}
