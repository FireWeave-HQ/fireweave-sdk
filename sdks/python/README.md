<a href="https://app.fireweave.ai">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/FireWeave-HQ/fireweave-sdk/main/.github/assets/banner-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/FireWeave-HQ/fireweave-sdk/main/.github/assets/banner-light.png">
    <img alt="Fireweave — agents write the code. We watch every rollout, under control." src="https://raw.githubusercontent.com/FireWeave-HQ/fireweave-sdk/main/.github/assets/banner-light.png" width="100%">
  </picture>
</a>

<p align="center">
  <a href="https://pypi.org/project/fireweave/"><img alt="python" src="https://img.shields.io/pypi/v/fireweave?label=python&logo=python&style=flat&labelColor=0E0E10&color=ED5502&logoColor=white"></a>
</p>

**Fireweave is the AI release engineer for teams shipping with coding agents.** Every change rolls out behind a control point, one step at a time, with guardrails watching real users — and if something breaks, Fireweave pauses or rolls it back before most users ever see it. It's the only way to ship as fast as your agents write code, without the fear of breaking production.

## Quick start · Python

```bash
pip install fireweave
```

```python
import os

from fireweave import EvaluationContext, RegisterTargetOptions, init_fireweave

client = init_fireweave(
    mode="remote",
    api_url=os.environ["FW_API_URL"],
    api_key=os.environ["FW_PROJECT_API_KEY"],
)

# Once per sign-in: the durable facts your targeting rules match on.
client.register_target(
    "user_42", RegisterTargetOptions(kind="user", properties={"plan": "pro"})
)

# Per request.
enabled = client.control_points.get_boolean_value(
    "new-checkout", False, EvaluationContext("user_42")
)
print("new-checkout:", enabled)

client.shutdown()
```

## Learn more

[Concepts](https://github.com/FireWeave-HQ/fireweave-sdk/blob/main/docs/concepts.md) · [Identity](https://github.com/FireWeave-HQ/fireweave-sdk/blob/main/docs/identity.md) · [Testing](https://github.com/FireWeave-HQ/fireweave-sdk/blob/main/docs/testing.md) · [Troubleshooting](https://github.com/FireWeave-HQ/fireweave-sdk/blob/main/docs/troubleshooting.md) · [All SDKs](https://github.com/FireWeave-HQ/fireweave-sdk#quick-start)

## License

[MIT](https://github.com/FireWeave-HQ/fireweave-sdk/blob/main/LICENSE)
