// FireweaveStart: the start profile (docs/adr/0012-start-profile.md).
//
// One synchronous `startFireweave()` call at launch, then reads from
// anywhere through the process-wide `fw`. It is a layer over the unchanged
// `Fireweave` core, which it re-exports, so `import FireweaveStart` is the
// only import an app needs.
//
// ```swift
// import FireweaveStart
//
// @main struct ShopApp: App {
//   init() { startFireweave(flags: appFlags) }
//   var body: some Scene { WindowGroup { RootView() } }
// }
//
// // anywhere
// if fw.controlPoints.getBooleanValue("new-checkout", default: false) { showNewCheckout() }
// ```
@_exported import Fireweave

// visionOS, tvOS and watchOS are not declared in Package.swift and have no
// profile rule yet: without this they would fall through to the server
// profile and fail at launch.
#if os(visionOS) || os(tvOS) || os(watchOS)
  #error("FireweaveStart does not support this platform yet. Use the Fireweave product directly.")
#endif
