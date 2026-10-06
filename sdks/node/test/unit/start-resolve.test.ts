/**
 * Start profile: the pure resolver (src/start/resolve.ts).
 * Precedence, mode rule, endpoint from channel, key family, control points.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStart, type BuildInfo } from '../../src/start/resolve.ts';
import { envFromBag, type EnvReader } from '../../src/start/env.ts';

const PROD: BuildInfo = { version: '2.4.0', channel: 'production' };
const STAGING: BuildInfo = { version: '2.4.0-staging.3', channel: 'staging' };
const KEY = 'project-api-key_abc123';

const env = (bag: Record<string, string>): EnvReader => envFromBag(bag);
/** A reader that fails the test if anything reads the environment. */
const noEnv: EnvReader = (name) => {
  throw new Error(`unexpected env read: ${name}`);
};
const configMessage = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    assert.equal((err as { kind?: string }).kind, 'Configuration');
    return (err as Error).message;
  }
  assert.fail('expected a Configuration error');
};

describe('mode: explicit override', () => {
  it("mode 'remote' with a key is remote", () => {
    const r = resolveStart({ mode: 'remote', key: KEY }, env({ NODE_ENV: 'development' }), PROD);
    assert.equal(r.mode, 'remote');
    assert.equal(r.modeSource, 'option');
  });

  it("mode 'remote' without a key is a boot error naming FIREWEAVE_KEY", () => {
    const message = configMessage(() => resolveStart({ mode: 'remote' }, env({}), PROD));
    assert.match(message, /mode: 'remote'.*FIREWEAVE_KEY/);
  });

  it("mode 'local' ignores a present key, with a warning", () => {
    const r = resolveStart({ mode: 'local' }, env({ FIREWEAVE_KEY: KEY, NODE_ENV: 'production' }), PROD);
    assert.equal(r.mode, 'local');
    assert.equal(r.key, undefined);
    assert.equal(r.url, undefined);
    assert.match(r.warnings.join('\n'), /ignores the key from FIREWEAVE_KEY/);
  });

  it('an unknown mode value is rejected', () => {
    assert.match(configMessage(() => resolveStart({ mode: 'auto' }, env({}), PROD)), /must be 'remote' or 'local'/);
  });
});

describe('mode: inference when mode is not set', () => {
  it('a key means remote, whatever the environment says', () => {
    const r = resolveStart({}, env({ FIREWEAVE_KEY: KEY, NODE_ENV: 'development' }), PROD);
    assert.equal(r.mode, 'remote');
    assert.equal(r.modeSource, 'key');
    assert.equal(r.environment, undefined);
  });

  for (const name of ['development', 'dev', 'local', 'test', 'Development', ' LOCAL ']) {
    it(`no key and environment '${name}' means local`, () => {
      const r = resolveStart({}, env({ NODE_ENV: name }), PROD);
      assert.equal(r.mode, 'local');
      assert.equal(r.modeSource, 'environment');
    });
  }

  it('the environment option beats FIREWEAVE_ENV, APP_ENV and NODE_ENV', () => {
    const r = resolveStart(
      { environment: 'dev' },
      env({ FIREWEAVE_ENV: 'production', APP_ENV: 'production', NODE_ENV: 'production' }),
      PROD,
    );
    assert.equal(r.mode, 'local');
    assert.equal(r.environmentSource, 'start({ environment })');
  });

  it('FIREWEAVE_ENV beats APP_ENV, which beats NODE_ENV', () => {
    assert.equal(resolveStart({}, env({ FIREWEAVE_ENV: 'dev', APP_ENV: 'prod', NODE_ENV: 'production' }), PROD).environmentSource, 'FIREWEAVE_ENV');
    assert.equal(resolveStart({}, env({ APP_ENV: 'dev', NODE_ENV: 'production' }), PROD).environmentSource, 'APP_ENV');
  });

  it('no key and a non-dev environment fails closed, naming both variables', () => {
    const message = configMessage(() => resolveStart({}, env({ APP_ENV: 'prod' }), PROD));
    assert.match(message, /FIREWEAVE_KEY is not set/);
    assert.match(message, /'prod' \(from APP_ENV\)/);
  });

  it('no key and no environment name fails closed (unset is not development)', () => {
    const message = configMessage(() => resolveStart({}, env({}), PROD));
    assert.match(message, /no environment name is set/);
  });

  it('points at FIREWEAVE_ENV when only the retired FW_ENV is set', () => {
    assert.match(configMessage(() => resolveStart({}, env({ FW_ENV: 'dev' }), PROD)), /FW_ENV is no longer read/);
  });

  it('empty and whitespace values count as unset', () => {
    const r = resolveStart({ key: '  ' }, env({ FIREWEAVE_KEY: '', FIREWEAVE_ENV: '   ', NODE_ENV: 'test' }), PROD);
    assert.equal(r.mode, 'local');
    assert.equal(r.environmentSource, 'NODE_ENV');
  });
});

describe('endpoint: inferred from the SDK channel, overridable', () => {
  it('a production build calls app-server.fireweave.ai', () => {
    const r = resolveStart({ key: KEY }, noEnvAfterKey(), PROD);
    assert.equal(r.url, 'https://app-server.fireweave.ai');
    assert.equal(r.allowedHosts, undefined);
  });

  it('a staging build calls staging-app-server.fireweave.ai', () => {
    const r = resolveStart({ key: KEY }, noEnvAfterKey(), STAGING);
    assert.equal(r.url, 'https://staging-app-server.fireweave.ai');
    assert.equal(r.channel, 'staging');
  });

  it('the url option wins and the allowlist follows it', () => {
    const r = resolveStart({ key: KEY, url: 'https://flags.example.com/' }, noEnv, STAGING);
    assert.equal(r.url, 'https://flags.example.com');
    assert.equal(r.urlSource, 'start({ url })');
    assert.deepEqual(r.allowedHosts, ['flags.example.com', 'localhost', '127.0.0.1', '::1']);
  });

  it('FIREWEAVE_URL beats the channel and the legacy names', () => {
    const r = resolveStart({}, env({ FIREWEAVE_KEY: KEY, FIREWEAVE_URL: 'https://a.example.com', FW_API_URL: 'https://b.example.com' }), PROD);
    assert.equal(r.url, 'https://a.example.com');
    assert.equal(r.warnings.length, 0);
  });

  it('legacy FW_API_URL and FW_ATTEST_URL are read with a warning', () => {
    const r = resolveStart({}, env({ FIREWEAVE_KEY: KEY, FW_ATTEST_URL: 'https://c.example.com' }), PROD);
    assert.equal(r.url, 'https://c.example.com');
    assert.match(r.warnings.join('\n'), /FW_ATTEST_URL is a legacy name.*FIREWEAVE_URL/);
  });

  it('http is allowed on localhost only, and the message never echoes the URL', () => {
    assert.equal(resolveStart({ key: KEY, url: 'http://127.0.0.1:3001' }, noEnv, PROD).url, 'http://127.0.0.1:3001');
    const message = configMessage(() => resolveStart({ key: KEY, url: 'http://flags.example.com' }, noEnv, PROD));
    assert.match(message, /from start\(\{ url \}\) must use https/);
    assert.doesNotMatch(message, /flags\.example\.com/);
  });

  it('an unparseable URL names its source', () => {
    assert.match(configMessage(() => resolveStart({}, env({ FIREWEAVE_KEY: KEY, FIREWEAVE_URL: 'not a url' }), PROD)), /from FIREWEAVE_URL is not a valid URL/);
  });

  it('local mode resolves no endpoint at all', () => {
    assert.equal(resolveStart({ mode: 'local', url: 'https://x.example.com' }, env({}), PROD).url, undefined);
  });
});

describe('key: resolved, family-checked, overridable', () => {
  it('the key option beats FIREWEAVE_KEY', () => {
    const r = resolveStart({ key: KEY }, noEnvAfterKey(), PROD);
    assert.equal(r.key, KEY);
    assert.equal(r.keySource, 'start({ key })');
  });

  it('legacy FW_PROJECT_API_KEY is read with a warning', () => {
    const r = resolveStart({}, env({ FW_PROJECT_API_KEY: KEY }), PROD);
    assert.equal(r.keySource, 'FW_PROJECT_API_KEY');
    assert.match(r.warnings.join('\n'), /FW_PROJECT_API_KEY is a legacy name.*FIREWEAVE_KEY/);
  });

  it('a browser key is rejected without printing it', () => {
    const message = configMessage(() => resolveStart({}, env({ FIREWEAVE_KEY: 'fw_public_secretvalue' }), PROD));
    assert.match(message, /browser key/);
    assert.doesNotMatch(message, /secretvalue/);
  });

  it('analytics vendor keys and org or CLI tokens are rejected', () => {
    assert.match(configMessage(() => resolveStart({ key: 'phc_abc' }, noEnv, PROD)), /analytics vendor key/);
    assert.match(configMessage(() => resolveStart({ key: 'fw_org_abc' }, noEnv, PROD)), /organisation or CLI token/);
    assert.match(configMessage(() => resolveStart({ key: 'cli_at_abc' }, noEnv, PROD)), /organisation or CLI token/);
  });

  it('a non-string key option is rejected', () => {
    assert.match(configMessage(() => resolveStart({ key: 42 }, noEnv, PROD)), /key.*must be a string/);
  });
});

describe('controlPoints', () => {
  it('accepts { key: { local } } and freezes it', () => {
    const r = resolveStart({ mode: 'local', controlPoints: { 'new-checkout': { local: true, description: 'x' } } }, env({}), PROD);
    assert.deepEqual(r.controlPoints, { 'new-checkout': { local: true, description: 'x' } });
    assert.ok(Object.isFrozen(r.controlPoints));
  });

  it('rejects a non-boolean local value and an invalid key', () => {
    assert.match(configMessage(() => resolveStart({ mode: 'local', controlPoints: { a: { local: 'yes' } } }, env({}), PROD)), /controlPoints\['a'\]/);
    assert.match(configMessage(() => resolveStart({ mode: 'local', controlPoints: { '': { local: true } } }, env({}), PROD)), /not a valid control point key/);
    assert.match(configMessage(() => resolveStart({ mode: 'local', controlPoints: [] }, env({}), PROD)), /must be an object/);
  });
});

/** Key from the option: the resolver must not need to read FIREWEAVE_KEY or the env name. */
function noEnvAfterKey(): EnvReader {
  return (name) => {
    if (name === 'FIREWEAVE_URL' || name === 'FW_API_URL' || name === 'FW_ATTEST_URL') return undefined;
    throw new Error(`unexpected env read: ${name}`);
  };
}
