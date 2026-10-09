/// Identities the start profile mints: the server's instance key and the
/// client's anonymous device id. Pure apart from the random fallbacks; the
/// environment and the host name are handed in by the server seam.
library;

import 'dart:convert';
import 'dart:math';

import 'names.dart';

/// FNV-1a 64-bit of [text]'s UTF-8 bytes, as 16 hex digits: the same
/// function as node (`src/start/instance.ts`) and go (`fw/instance.go`), so
/// one host name gives one instance key in every SDK. Not a security hash.
///
/// Computed on two 32-bit halves so it is exact on every Dart platform,
/// including dart2js, where integers are doubles.
String fnv1a64(String text) {
  // Offset basis 0xcbf29ce484222325, prime 0x100000001b3 = 2^40 + 0x1b3.
  var hi = 0xcbf29ce4;
  var lo = 0x84222325;
  const two32 = 0x100000000;
  for (final byte in utf8.encode(text)) {
    lo ^= byte;
    // (hi:lo) * 0x1b3
    final loProduct = lo * 0x1b3;
    final carry = loProduct ~/ two32;
    final newLo = loProduct % two32;
    var newHi = (hi * 0x1b3 + carry) % two32;
    // + (hi:lo) << 40: only lo's low 24 bits land in the high word.
    newHi = (newHi + (lo % 0x1000000) * 0x100) % two32;
    hi = newHi;
    lo = newLo;
  }
  return hi.toRadixString(16).padLeft(8, '0') +
      lo.toRadixString(16).padLeft(8, '0');
}

/// A secure source when the platform has one that works. Some JavaScript
/// hosts throw from it on first use (a TypeError, not an UnsupportedError),
/// so it is probed once and a plain [Random] is used instead; the ids are
/// anonymous bucketing keys, not secrets.
Random _random() {
  try {
    final secure = Random.secure();
    secure.nextInt(256);
    return secure;
  } on Object {
    return Random();
  }
}

String _hex(int bytes) {
  final random = _random();
  final buffer = StringBuffer();
  for (var i = 0; i < bytes; i += 1) {
    buffer.write(random.nextInt(256).toRadixString(16).padLeft(2, '0'));
  }
  return buffer.toString();
}

/// Where an instance key came from.
enum InstanceKeySource {
  option,
  environment,
  host,
  random;

  /// The name a status or message uses.
  String get label => switch (this) {
    InstanceKeySource.option => 'option',
    InstanceKeySource.environment => instanceIdVariable,
    InstanceKeySource.host => 'host',
    InstanceKeySource.random => 'random',
  };
}

/// The server's instance key: the `instanceId` option, then
/// `FIREWEAVE_INSTANCE_ID`, then `inst_` + [fnv1a64] of the host name, then
/// a random id for the life of the isolate. Nothing is written to disk.
({String value, InstanceKeySource source}) deriveInstanceKey(
  String? option,
  String? Function(String name) read,
  String? Function() hostName,
) {
  final fromOption = option?.trim() ?? '';
  if (fromOption.isNotEmpty) {
    return (value: fromOption, source: InstanceKeySource.option);
  }
  final fromEnv = read(instanceIdVariable)?.trim() ?? '';
  if (fromEnv.isNotEmpty) {
    return (value: fromEnv, source: InstanceKeySource.environment);
  }
  final host = hostName()?.trim() ?? '';
  if (host.isNotEmpty) {
    return (value: 'inst_${fnv1a64(host)}', source: InstanceKeySource.host);
  }
  return (value: 'inst_${_hex(16)}', source: InstanceKeySource.random);
}

/// A fresh anonymous device id, `dev_<uuid v4>`: the key and prefix the web
/// SDK and the scaffolded harnesses use.
String mintDeviceId() {
  final random = _random();
  final bytes = List<int>.generate(16, (_) => random.nextInt(256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  return 'dev_${hex.substring(0, 8)}-${hex.substring(8, 12)}-'
      '${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}
