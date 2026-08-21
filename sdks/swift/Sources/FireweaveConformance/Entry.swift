import Fireweave
import Foundation

/// CLI entry point: run the `contracts/` fixtures the swift SDK's
/// architecture can represent, emit the compatibility report
/// (`contracts/README.md` schema — fixtureId/suite/language/status/
/// limitation/message rows, the same shape node/python/go/java/rust write).
///
/// Usage:
///
///     swift run FireweaveConformance --contracts ../../contracts --out conformance/compatibility-report.swift.json
///
/// Exit code is non-zero when any fixture fails (`contracts/harness.md`
/// runner obligation 6).

func repoRoot() -> URL {
  // sdks/swift/Sources/FireweaveConformance/main.swift -> sdks/swift -> sdks -> repo root
  URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
}

struct Args {
  var contracts: URL
  var out: URL
}

func parseArgs() -> Args {
  var contracts = repoRoot().appendingPathComponent("contracts")
  var out = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .appendingPathComponent("conformance/compatibility-report.swift.json")
  let args = Array(CommandLine.arguments.dropFirst())
  var i = 0
  while i < args.count {
    switch args[i] {
    case "--contracts":
      i += 1
      precondition(i < args.count, "--contracts requires a path")
      contracts = URL(fileURLWithPath: args[i])
    case "--out":
      i += 1
      precondition(i < args.count, "--out requires a path")
      out = URL(fileURLWithPath: args[i])
    default:
      fatalError("unknown argument \(args[i])")
    }
    i += 1
  }
  return Args(contracts: contracts, out: out)
}

@main
struct FireweaveConformanceMain {
  static func main() async {
    let args = parseArgs()
    let report = await Runner.runAll(contractsDir: args.contracts)

    let outDir = args.out.deletingLastPathComponent()
    try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
    let json = report.toJSON()
    let data =
      (try? JSONSerialization.data(
        withJSONObject: json.toFoundationAny(), options: [.prettyPrinted, .sortedKeys]
      )) ?? Data()
    try? (data + Data("\n".utf8)).write(to: args.out)

    let summary = report.summary()
    print(
      "conformance[swift]: \(summary[Status.pass] ?? 0) passed, \(summary[Status.fail] ?? 0) failed, "
        + "\(summary[Status.skippedWithDocumentedLimitation] ?? 0) skipped-with-documented-limitation, "
        + "\(summary[Status.skippedV1OutOfScope] ?? 0) skipped-v1-out-of-scope (report: \(args.out.path))"
    )

    if (summary[Status.fail] ?? 0) > 0 {
      for row in report.results where row.status == Status.fail {
        print("  FAIL \(row.suite)/\(row.fixtureId)\(row.message.map { " - \($0)" } ?? "")")
      }
      exit(1)
    }
  }
}
