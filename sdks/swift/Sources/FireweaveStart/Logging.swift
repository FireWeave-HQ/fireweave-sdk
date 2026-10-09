import Foundation

#if canImport(os)
  import os
#endif

/// How loud a `[fireweave]` line is: the local-mode line and the core's
/// local `registerTarget` trace are info; everything else is a warning.
enum LogLevel: Sendable {
  case info
  case warning
}

struct LogLine: Sendable, Equatable {
  var level: LogLevel
  var text: String
}

/// The default sink when `startFireweave(log:)` is not set: the unified log
/// (subsystem `ai.fireweave.sdk`, category `start`) on Apple platforms, so
/// lines show up in Console.app and in device logs, and standard error
/// elsewhere.
func writeDefaultLog(_ line: LogLine) {
  #if canImport(os)
    let logger = Logger(subsystem: "ai.fireweave.sdk", category: "start")
    switch line.level {
    case .info:
      logger.info("\(line.text, privacy: .public)")
    case .warning:
      logger.warning("\(line.text, privacy: .public)")
    }
  #else
    FileHandle.standardError.write(Data((line.text + "\n").utf8))
  #endif
}
