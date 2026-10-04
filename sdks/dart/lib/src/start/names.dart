/// Every name the start profile reads, in one place, so the README, the
/// initialise skill and the error messages cannot drift apart (node:
/// `src/start/names.ts`, web: `src/start/names.ts`, go: `fw/names.go`).
library;

/// The server profile's key variable (process environment).
const String serverKeyVariable = 'FIREWEAVE_KEY';

/// The client profile's key define (`--dart-define` / `--dart-define-from-file`).
const String browserKeyVariable = 'FIREWEAVE_BROWSER_KEY';

/// The fw-server endpoint override (a define on clients, an env var on servers).
const String urlVariable = 'FIREWEAVE_URL';

/// The environment name that feeds the mode rule.
const String environmentVariable = 'FIREWEAVE_ENV';

/// The server profile's fallback environment name, after [environmentVariable].
const String serverEnvironmentFallback = 'APP_ENV';

/// The server profile's instance id override.
const String instanceIdVariable = 'FIREWEAVE_INSTANCE_ID';

/// Read before the operating system's host name, as node does, so a
/// container's own `HOSTNAME` (and a test's env map) decides.
const String hostNameVariable = 'HOSTNAME';

/// Legacy key name written by the scaffolded harness. Read by the server
/// profile only when [serverKeyVariable] is unset, with one warning, for all
/// of 2.x.
const List<String> legacyKeyNames = <String>['FW_PROJECT_API_KEY'];

/// Legacy endpoint names, read like [legacyKeyNames].
const List<String> legacyUrlNames = <String>['FW_API_URL', 'FW_ATTEST_URL'];

/// The harness's environment name. Never read for its value: the server
/// profile only looks at it to explain a boot error.
const String retiredEnvironmentName = 'FW_ENV';

/// Environment names that mean "local development" when no key is set.
/// Compared trimmed and case-insensitively.
const Set<String> devEnvironments = <String>{
  'development',
  'dev',
  'local',
  'test',
};

/// fw-server host of a production build of this package.
const String productionUrl = 'https://app-server.fireweave.ai';

/// fw-server host of a `-staging.N` build of this package.
const String stagingUrl = 'https://staging-app-server.fireweave.ai';

/// Hosts always allowed beside a custom endpoint, so local stacks keep
/// working.
const List<String> loopbackHosts = <String>['localhost', '127.0.0.1', '::1'];

/// The only key family a client app may hold.
const String browserKeyPrefix = 'fw_public_';

/// The server-family key prefix, named in the client's "server key" message.
const String serverKeyPrefix = 'project-api-key_';

/// Where the flags map lives by convention; named in warnings.
const String flagsFile = 'lib/fireweave/flags.dart';
