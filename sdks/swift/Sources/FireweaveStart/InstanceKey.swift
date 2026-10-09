import Foundation

/// FNV-1a 64-bit as 16 lower-case hex digits: the same function the Node, Go,
/// Java and Rust start profiles use, so one host name gives one instance key
/// in every SDK. Not a security hash.
func fnv1a64(_ text: String) -> String {
  var hash: UInt64 = 0xcbf2_9ce4_8422_2325
  for byte in text.utf8 {
    hash ^= UInt64(byte)
    hash = hash &* 0x100_0000_01b3
  }
  let hex = String(hash, radix: 16)
  return String(repeating: "0", count: max(0, 16 - hex.count)) + hex
}

/// Where an instance key came from.
enum InstanceKeySource: String, Sendable {
  case option
  case environment
  case host
  case random
}

struct InstanceKey: Sendable, Equatable {
  var value: String
  var source: InstanceKeySource
}

/// A stable targeting key for a server process: the `instanceId` option,
/// else `FIREWEAVE_INSTANCE_ID`, else `inst_` plus a hash of the host name
/// (`HOSTNAME`, then the POSIX host name), else a random id for the life of
/// the process. Nothing is written to disk: in a container the file would
/// not outlive the process.
///
/// Pure apart from the random fallback: the lookups are injected.
func deriveInstanceKey(
  option: String?,
  env: (String) -> String?,
  hostName: () -> String?
) -> InstanceKey {
  if let value = nonBlank(option) {
    return InstanceKey(value: value, source: .option)
  }
  if let value = nonBlank(env(StartNames.instanceId)) {
    return InstanceKey(value: value, source: .environment)
  }
  if let host = nonBlank(env(StartNames.hostName)) ?? nonBlank(hostName()) {
    return InstanceKey(value: StartNames.instanceKeyPrefix + fnv1a64(host), source: .host)
  }
  let random = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
  return InstanceKey(value: StartNames.instanceKeyPrefix + random, source: .random)
}
