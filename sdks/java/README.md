<a href="https://app.fireweave.ai">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/FireWeave-HQ/fireweave-sdk/main/.github/assets/banner-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/FireWeave-HQ/fireweave-sdk/main/.github/assets/banner-light.png">
    <img alt="Fireweave — agents write the code. We watch every rollout, under control." src="https://raw.githubusercontent.com/FireWeave-HQ/fireweave-sdk/main/.github/assets/banner-light.png" width="100%">
  </picture>
</a>

<p align="center">
  <a href="https://central.sonatype.com/artifact/ai.fireweave/fireweave-sdk"><img alt="java" src="https://img.shields.io/maven-metadata/v?metadataUrl=https%3A%2F%2Frepo1.maven.org%2Fmaven2%2Fai%2Ffireweave%2Ffireweave-sdk%2Fmaven-metadata.xml&label=java&logo=openjdk&style=flat&labelColor=0E0E10&color=ED5502&logoColor=white"></a>
</p>

**Fireweave is the AI release engineer for teams shipping with coding agents.** Every change rolls out behind a control point, one step at a time, with guardrails watching real users — and if something breaks, Fireweave pauses or rolls it back before most users ever see it. It's the only way to ship as fast as your agents write code, without the fear of breaking production.

## Quick start · Java

```xml
<dependency>
  <groupId>ai.fireweave</groupId>
  <artifactId>fireweave-sdk</artifactId>
  <version>3.0.0</version>
</dependency>
```

```java
import ai.fireweave.sdk.application.Fireweave;
import ai.fireweave.sdk.application.FireweaveClient;
import ai.fireweave.sdk.application.InitOptions;
import ai.fireweave.sdk.application.RegisterTargetOptions;
import ai.fireweave.sdk.domain.EvaluationContext;
import ai.fireweave.sdk.domain.JsonValue;
import ai.fireweave.sdk.domain.TargetKind;

public class Quickstart {
    public static void main(String[] args) {
        // remote(apiKey, apiUrl): the SDK never reads env vars itself
        InitOptions options = InitOptions.remote(
                System.getenv("FW_PROJECT_API_KEY"), System.getenv("FW_API_URL"));

        try (FireweaveClient client = Fireweave.init(options)) {
            client.registerTarget("user_42", RegisterTargetOptions.builder()
                    .kind(TargetKind.USER)
                    .property("plan", JsonValue.of("pro"))
                    .build());

            boolean enabled = client.controlPoints().getBooleanValue("new-checkout", false,
                    EvaluationContext.builder().targetingKey("user_42").build());
            System.out.println("new-checkout = " + enabled);
        }
    }
}
```

## Learn more

[Concepts](https://github.com/FireWeave-HQ/fireweave-sdk/blob/main/docs/concepts.md) · [Identity](https://github.com/FireWeave-HQ/fireweave-sdk/blob/main/docs/identity.md) · [Testing](https://github.com/FireWeave-HQ/fireweave-sdk/blob/main/docs/testing.md) · [Troubleshooting](https://github.com/FireWeave-HQ/fireweave-sdk/blob/main/docs/troubleshooting.md) · [All SDKs](https://github.com/FireWeave-HQ/fireweave-sdk#quick-start)

## License

[MIT](https://github.com/FireWeave-HQ/fireweave-sdk/blob/main/LICENSE)
