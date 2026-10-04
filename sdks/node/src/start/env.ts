/**
 * The ONLY place the SDK reads the process environment.
 *
 * The core SDK reads no environment variables (spec/modes.md). The start
 * profile is the documented exception (docs/adr/0012-start-profile.md), and
 * test/unit/runtime-portability.test.ts pins every env read to this file.
 *
 * Works on Node, Bun and Deno without importing a runtime module: Node and Bun
 * expose `process.env`; Deno exposes `Deno.env.get`, which throws when the
 * process lacks --allow-env. That refusal is reported, not swallowed, so a
 * Deno app never boots with a key it was not allowed to read.
 */
import { FireweaveError } from '../index.js';

/** Reads one variable. Returns undefined when unset, empty, or only whitespace. */
export type EnvReader = (name: string) => string | undefined;

interface DenoLike {
  env?: { get(name: string): string | undefined };
}
interface ProcessLike {
  env?: Record<string, string | undefined>;
}

const clean = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/** Reader over an explicit bag (start({ env }) and tests). Only string values count. */
export function envFromBag(bag: Readonly<Record<string, unknown>>): EnvReader {
  return (name) => clean(bag[name]);
}

/** Reader over the running process: Deno.env first, then process.env. */
export function processEnv(): EnvReader {
  const deno = (globalThis as { Deno?: DenoLike }).Deno;
  if (deno?.env !== undefined) {
    return (name) => {
      try {
        return clean(deno.env?.get(name));
      } catch (cause) {
        throw new FireweaveError('Configuration', {
          message: `[fireweave] Deno refused to read ${name}. Run with --allow-env=${name}, or pass the value to start() explicitly.`,
          cause,
        });
      }
    };
  }
  const proc = (globalThis as { process?: ProcessLike }).process;
  const env = proc?.env;
  if (env === undefined) return () => undefined;
  return (name) => clean(env[name]);
}

/**
 * A reader that never throws, for values only needed to word a warning or an
 * error (for example "FW_ENV is no longer read").
 */
export function quiet(read: EnvReader): EnvReader {
  return (name) => {
    try {
      return read(name);
    } catch {
      return undefined;
    }
  };
}
