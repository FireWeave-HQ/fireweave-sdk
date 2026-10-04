# Start profile — one-line setup over the core

- **Status:** Proposed (ADR-0012). Normative for every SDK that ships a start profile once
  ADR-0012 is accepted.
- **Applies to:** the start layer of every language SDK in `sdks/` — Node and web
  (`@fireweaveai/server-sdk/start`, `@fireweaveai/web-sdk/start`), Python (`fireweave.start`),
  Go (`.../sdks/go/v2/fw`), Java (`ai.fireweave.sdk.start`), Rust (`fireweave::start`), Dart
  (`package:fireweave/client.dart`, `server.dart`) and Swift (`FireweaveStart`).
- **Related:** `modes.md` (the core rules this layer is the documented exception to),
  `control-points.md`, `remote-protocol.md`, ADR-0012.
- **Conformance:** `contracts/start/` (this document's rule ids are cited by each fixture).

The core (`initFireweave` and everything under it) is unchanged: `mode` is required, nothing is
inferred, and no environment is read (`modes.md`). The **start profile** is an opt-in layer that
answers those questions by rule so an app needs one call instead of a generated harness. Only the
start profile may do the things this document allows; the core never does.

## 1. Profiles

| Profile | Runs in | Key family | Configuration comes from |
| --- | --- | --- | --- |
| **server** | Node/Bun/Deno, Python, Go, Java, Rust, the Dart VM, Swift on servers | project keys (`project-api-key_…`) | `start()` options, then the process environment |
| **client** | browsers (web), Flutter and Dart web, iOS/macOS apps | browser keys (`fw_public_…`) | `start()` options, then values fixed at **build** time |

A client profile MUST NOT read the process environment at run time (a shipped app has none it can
trust). Its build-time values come from a build helper (web: the `fireweave()` Vite plugin or
`fireweaveDefine()`), compile-time defines (Dart, read only as `const` expressions) or Info.plist
(Swift). **[SP-1]**

## 2. Names

| Setting | Option | Server variable | Client build value | Legacy name (server, warns once) |
| --- | --- | --- | --- | --- |
| key | `key` | `FIREWEAVE_KEY` | `FIREWEAVE_BROWSER_KEY` | `FW_PROJECT_API_KEY` |
| endpoint | `url` | `FIREWEAVE_URL` | `FIREWEAVE_URL` | `FW_API_URL`, then `FW_ATTEST_URL` |
| environment name | `environment` | `FIREWEAVE_ENV`, then `APP_ENV` | `FIREWEAVE_ENV` | — |
| instance id | `instanceId` (`instance_id`) | `FIREWEAVE_INSTANCE_ID` | — | — |
| local values | `flags` | — | — | — |
| mode override | `mode` | — | — | — |

Option spellings follow each language's convention (`instance_id` in Python and Rust,
`InstanceID` in Go). `FW_ENV` is **not** read; an SDK MAY mention it in the missing-key error
when it is set. **[SP-2]**

Language-conventional environment-name fallbacks after `APP_ENV` are allowed and listed here:
Node reads `NODE_ENV`; web build helpers read `APP_ENV` and, outside Vite, `NODE_ENV`; the web
Vite plugin and Vitest use Vite's `mode` for the dev server only — **never** for a production
build. **[SP-3]**

## 3. Precedence and blank values

Every setting resolves as: explicit option → the profile's variable or build value → the legacy
name (server only, with one warning naming the legacy variable and its replacement) → the
default. A source is consulted only when every earlier one is unset. **[SP-4]**

An empty or whitespace-only value counts as **unset** at every step, and values are trimmed.
**[SP-5]**

## 4. The mode rule

Evaluated after resolution:

1. An explicit `mode` wins. `'local'` ignores any key and emits one warning naming the key's
   source. `'remote'` without a key is a Configuration error naming the key variable. Any other
   value is a Configuration error. **[SP-6]**
2. A key is present → **remote**. **[SP-7]**
3. No key, and the environment name (trimmed, compared case-insensitively) is one of
   `development`, `dev`, `local`, `test` → **local**. **[SP-8]**
4. Anything else — including no environment name at all — is a **Configuration error** that names
   the key variable (`FIREWEAVE_KEY` or `FIREWEAVE_BROWSER_KEY`). The profile fails closed: a
   deploy without its key never becomes silent local evaluation. **[SP-9]**

The reported `modeSource` is `option`, `key` or `environment`. **[SP-10]**

A client profile MAY add a build-mode signal that only a debug build can produce (Swift's
`FireweaveStart` debug define). It MUST NOT be reachable from a release build. **[SP-11]**

## 5. Endpoint and release channel

The default endpoint follows the SDK build's own **release channel**: a staging build calls
`https://staging-app-server.fireweave.ai`; any other build calls `https://app-server.fireweave.ai`.
**[SP-12]** A version is staging when it carries the staging pre-release used by
`tools/release/version.sh`: `-staging.N` everywhere except Python, whose staging builds are PEP 440
pre-releases (`X.Y.ZaN`). An unknown or development version (`(devel)`, `-SNAPSHOT`) is
production. **[SP-13]**

How an SDK learns its version is its own business (a stamped build-info file for TypeScript, Dart
and Swift; the installed distribution for Python; the binary's build info for Go; a filtered
resource for Java; `CARGO_PKG_VERSION` for Rust).

With the default endpoint the core's own host allowlist applies (`allowedHosts` absent). An
explicit `url` (option or variable):

- has trailing slashes removed;
- MUST be `https`, except on loopback (`localhost`, `127.0.0.1`, `::1`) where `http` is allowed;
  anything else is a Configuration error naming the source;
- replaces the allowlist with `[url host, localhost, 127.0.0.1, ::1]`. **[SP-14]**

The web client also accepts a same-origin path (`/fw`) resolved against the page origin; other
profiles do not. **[SP-15]**

## 6. Key families

Checked before any request. Error messages name the **source** (option or variable) and never
the value. **[SP-16]**

| Key | Server profile | Client profile |
| --- | --- | --- |
| `project-api-key_…` | accepted | **rejected**: a server key must never ship to a client; the message says to revoke it |
| `fw_public_…` | **rejected** (browser key on a server) | accepted |
| analytics-vendor keys (`ph` + one letter + `_`) | rejected | rejected |
| `fw_org_…`, `cli_at_…` | rejected | rejected |
| anything else | accepted (the core validates it) | rejected |

**[SP-17]**

## 7. Flags

`flags` maps each control-point key to its **local** value (`{ local: boolean, description? }` or
the language's equivalent). Keys are validated with the core's control-point key rule; a non-boolean
local value is an error. Local values are served **only** in local mode; remote ignores them, and a
call site's default stays `false` (RAMP-1). In local mode a read of a key missing from the flags
returns the caller's default and warns once, naming the flags file. **[SP-18]**

## 8. Singleton, idempotency and reads

- One client per process (per isolate in Dart; per page in browsers). **[SP-19]**
- A second `start()` with the same effective configuration is a no-op. A different one is an error
  on servers; client profiles log it once and keep the first. The comparison covers mode, url,
  key, allowed hosts and the instance or device id; flags count only in local mode. **[SP-20]**
- Reads never throw. Before start settles, or after it failed, a read returns the caller's default
  (the details forms return an `ERROR` decision). Server profiles in languages where a read can start
  the client (Node, Python, Go, Java, Rust) start it from the environment alone on the first read;
  client profiles return `NotReady` defaults and warn once. **[SP-21]**
- `status` reports mode, why, channel, host, sources and any problem, and never the key. **[SP-22]**
- A configuration fault in a **client** profile SHOULD NOT crash the app: it is reported through
  `status` and one log line, and reads serve defaults (web, Dart). Swift's app profile currently
  throws from `startFireweave` (open item, ADR-0012). Server profiles fail loudly. **[SP-23]**

## 9. Instance key (server profiles)

`instanceKey()` is the targeting key for reads where the server itself is the subject. It
resolves as: the `instanceId` option (verbatim) → `FIREWEAVE_INSTANCE_ID` (verbatim) →
`inst_` + the 16-hex-digit FNV-1a 64-bit hash of the host name's UTF-8 bytes → `inst_` + a random
value for the life of the process. Nothing is written to disk, and the key is never sent as an
implicit context. **[SP-24]**

FNV-1a 64: offset basis `0xcbf29ce484222325`, prime `0x100000001b3`, lower-case hex, zero-padded
to 16 digits. Test vectors: `api-pod-1` → `8148fc8bb0e952ef`, `ip-10-0-0-12.ec2.internal` →
`1e183a27e4e4c211`, `hôte-ü` → `7cf801ffb8f0c725`. **[SP-25]**

## 10. What the start profile never does

- It never changes the core's behaviour, never sends the environment name anywhere, and never
  reads a client key from the process environment.
- It never prints a key, in errors, warnings or `status`. **[SP-26]**
