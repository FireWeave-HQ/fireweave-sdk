/**
 * Runtime-agnostic environment read.
 *
 * Node and Bun expose `process.env`. Deno exposes `Deno.env.get`, which THROWS
 * when `--allow-env` was not granted — so the lookup is guarded: constructing an
 * adapter with explicit options must never fail because of a permission it does
 * not actually need.
 *
 * Deno's Node-compat `process.env` also throws NotCapable without `--allow-env`,
 * so the process.env path is try/caught the same way.
 *
 * Returns undefined on any runtime that offers neither.
 */
interface ProcessLike {
  env?: Record<string, string | undefined> | undefined;
}

interface DenoLike {
  env?: { get(key: string): string | undefined } | undefined;
}

export function readEnv(name: string): string | undefined {
  const proc = (globalThis as { process?: ProcessLike }).process;
  if (proc?.env !== undefined) {
    try {
      const fromProcess = proc.env[name];
      if (fromProcess !== undefined) return fromProcess;
    } catch {
      // Deno node-compat process.env without --allow-env: absent, not fatal.
    }
  }

  const deno = (globalThis as { Deno?: DenoLike }).Deno;
  if (deno?.env === undefined) return undefined;
  try {
    return deno.env.get(name);
  } catch {
    // Deno without --allow-env: absent, not fatal.
    return undefined;
  }
}
