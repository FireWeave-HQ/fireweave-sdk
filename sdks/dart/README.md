<a href="https://app.fireweave.ai">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/FireWeave-HQ/fireweave-sdk/main/.github/assets/banner-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/FireWeave-HQ/fireweave-sdk/main/.github/assets/banner-light.png">
    <img alt="Fireweave — agents write the code. We watch every rollout, under control." src="https://raw.githubusercontent.com/FireWeave-HQ/fireweave-sdk/main/.github/assets/banner-light.png" width="100%">
  </picture>
</a>

<p align="center">
  <a href="https://github.com/FireWeave-HQ/fireweave-sdk/tree/main/sdks/dart"><img alt="dart" src="https://img.shields.io/badge/dart-from%20source-ED5502?logo=dart&style=flat&labelColor=0E0E10&logoColor=white"></a>
</p>

**Fireweave is the AI release engineer for teams shipping with coding agents.** Every change rolls out behind a control point, one step at a time, with guardrails watching real users — and if something breaks, Fireweave pauses or rolls it back before most users ever see it. It's the only way to ship as fast as your agents write code, without the fear of breaking production.

## Quick start · Dart · Flutter

```yaml
# Not on pub.dev yet: clone next to your app and depend on it by path
dependencies:
  fireweave:
    path: ../fireweave-sdk/sdks/dart
```

```dart
import 'package:fireweave/fireweave.dart';

final fw = await initFireweave(InitFireweaveOptions.remote(
  apiKey: 'project-api-key_...',
  apiUrl: 'https://app-server.fireweave.ai',
  context: EvaluationContext(targetingKey: deviceId), // prefetch under a stable key
));

// Once per login: register the target, then prefetch its decisions.
await fw.identify('user_42',
    options: const RegisterTargetOptions(properties: {'plan': 'pro'}));

// Inside build(): synchronous, never throws.
final enabled = fw.controlPoints.getBooleanValue('new-checkout', false);

await fw.shutdown();
```

## Learn more

[Concepts](https://github.com/FireWeave-HQ/fireweave-sdk/blob/main/docs/concepts.md) · [Identity](https://github.com/FireWeave-HQ/fireweave-sdk/blob/main/docs/identity.md) · [Testing](https://github.com/FireWeave-HQ/fireweave-sdk/blob/main/docs/testing.md) · [Troubleshooting](https://github.com/FireWeave-HQ/fireweave-sdk/blob/main/docs/troubleshooting.md) · [All SDKs](https://github.com/FireWeave-HQ/fireweave-sdk#quick-start)

## License

[MIT](https://github.com/FireWeave-HQ/fireweave-sdk/blob/main/LICENSE)
