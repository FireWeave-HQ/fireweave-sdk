/// The ONLY file in this package that reads compile-time defines.
///
/// The core reads no environment and no defines (`spec/modes.md`); the
/// client start profile is the documented exception
/// (docs/adr/0012-start-profile.md). Values arrive at build time through
/// `--dart-define=NAME=value` or `--dart-define-from-file=fireweave.env`
/// (Flutter) and `-DNAME=value` (`dart run`, `dart compile`).
///
/// Every read here is a `const` declaration with a string-literal name, and
/// must stay one: a define read that is not a constant evaluates to the
/// empty string under AOT and throws under dart2js.
/// test/start_guard_test.dart pins that, and pins every such read to this
/// file.
///
/// The browser key is public by construction (it ships inside the app), so
/// compiling it in is the design. The server key is never read here: only
/// its presence is checked, so a server key in a client's define file is
/// reported without its value ever being compiled in.
library;

/// `FIREWEAVE_BROWSER_KEY`: the client's key (`fw_public_…`).
const String definedBrowserKey = String.fromEnvironment(
  'FIREWEAVE_BROWSER_KEY',
);

/// `FIREWEAVE_URL`: the fw-server endpoint override.
const String definedUrl = String.fromEnvironment('FIREWEAVE_URL');

/// `FIREWEAVE_ENV`: the environment name that feeds the mode rule.
const String definedEnvironment = String.fromEnvironment('FIREWEAVE_ENV');

/// Whether `FIREWEAVE_KEY` (the server key) was passed as a define. Its
/// value is never read.
const bool definedServerKeyPresent = bool.hasEnvironment('FIREWEAVE_KEY');

/// The defines as a map, the shape the client profile resolves from. Tests
/// hand the profile their own map instead; defines cannot be set at run
/// time.
const Map<String, String> compiledDefines = <String, String>{
  'FIREWEAVE_BROWSER_KEY': definedBrowserKey,
  'FIREWEAVE_URL': definedUrl,
  'FIREWEAVE_ENV': definedEnvironment,
  if (definedServerKeyPresent) 'FIREWEAVE_KEY': '',
};
