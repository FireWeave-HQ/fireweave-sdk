<a href="https://app.fireweave.ai">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/FireWeave-HQ/fireweave-sdk/main/.github/assets/banner-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/FireWeave-HQ/fireweave-sdk/main/.github/assets/banner-light.png">
    <img alt="Fireweave — agents write the code. We watch every rollout, under control." src="https://raw.githubusercontent.com/FireWeave-HQ/fireweave-sdk/main/.github/assets/banner-light.png" width="100%">
  </picture>
</a>

<p align="center">
  <a href="https://www.npmjs.com/package/@fireweaveai/web-sdk"><img alt="web" src="https://img.shields.io/npm/v/@fireweaveai/web-sdk?label=web&logo=javascript&style=flat&labelColor=0E0E10&color=ED5502&logoColor=white"></a>
</p>

**Fireweave is the AI release engineer for teams shipping with coding agents.** Every change rolls out behind a control point, one step at a time, with guardrails watching real users — and if something breaks, Fireweave pauses or rolls it back before most users ever see it. It's the only way to ship as fast as your agents write code, without the fear of breaking production.

## Quick start · Web (browser)

```bash
npm install @fireweaveai/web-sdk
```

```ts
import { initFireweave } from '@fireweaveai/web-sdk';

const fireweave = await initFireweave({
  mode: 'remote',
  apiUrl: 'https://app-server.fireweave.ai',
  apiKey: 'YOUR_PROJECT_API_KEY',
});

// Register the user, then fetch their decisions.
await fireweave.identify('user_42', { kind: 'user', properties: { plan: 'pro' } });

// Reads are synchronous: safe inside a render path.
const enabled = fireweave.controlPoints.getBooleanValue('new-checkout', false);
console.log('new-checkout:', enabled);

await fireweave.shutdown();
```

## Learn more

[Concepts](https://github.com/FireWeave-HQ/fireweave-sdk/blob/main/docs/concepts.md) · [Identity](https://github.com/FireWeave-HQ/fireweave-sdk/blob/main/docs/identity.md) · [Testing](https://github.com/FireWeave-HQ/fireweave-sdk/blob/main/docs/testing.md) · [Troubleshooting](https://github.com/FireWeave-HQ/fireweave-sdk/blob/main/docs/troubleshooting.md) · [Module formats (CommonJS)](https://github.com/FireWeave-HQ/fireweave-sdk/blob/main/docs/module-formats.md) · [All SDKs](https://github.com/FireWeave-HQ/fireweave-sdk#quick-start)

## License

[MIT](https://github.com/FireWeave-HQ/fireweave-sdk/blob/main/LICENSE)
