<a href="https://app.fireweave.ai">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/FireWeave-HQ/fireweave-sdk/main/.github/assets/banner-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/FireWeave-HQ/fireweave-sdk/main/.github/assets/banner-light.png">
    <img alt="Fireweave — agents write the code. We watch every rollout, under control." src="https://raw.githubusercontent.com/FireWeave-HQ/fireweave-sdk/main/.github/assets/banner-light.png" width="100%">
  </picture>
</a>

<p align="center">
  <a href="https://pkg.go.dev/github.com/FireWeave-HQ/fireweave-sdk/sdks/go/v3"><img alt="go" src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fproxy.golang.org%2Fgithub.com%2F%21fire%21weave-%21h%21q%2Ffireweave-sdk%2Fsdks%2Fgo%2Fv3%2F%40latest&query=%24.Version&label=go&logo=go&style=flat&labelColor=0E0E10&color=ED5502&logoColor=white"></a>
</p>

**Fireweave is the AI release engineer for teams shipping with coding agents.** Every change rolls out behind a control point, one step at a time, with guardrails watching real users — and if something breaks, Fireweave pauses or rolls it back before most users ever see it. It's the only way to ship as fast as your agents write code, without the fear of breaking production.

## Quick start · Go

```bash
go get github.com/FireWeave-HQ/fireweave-sdk/sdks/go/v3
```

```go
package main

import (
	"context"
	"fmt"
	"log"
	"os"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/v3/fireweave"
)

func main() {
	client, err := fireweave.Init(fireweave.Options{
		Mode:   fireweave.ModeRemote,
		APIURL: os.Getenv("FW_API_URL"),
		APIKey: os.Getenv("FW_PROJECT_API_KEY"),
	})
	if err != nil {
		log.Fatal(err)
	}
	defer client.Runtime().Shutdown(context.Background())

	// Once per login: the durable facts your targeting rules match on.
	client.RegisterTarget("user_42", &fireweave.RegisterTargetOptions{
		Kind:       fireweave.TargetKindUser,
		Properties: map[string]any{"plan": "pro"},
	})

	// Per request: evaluate a control point.
	user := fireweave.NewEvaluationContext("user_42", nil)
	enabled := client.ControlPoints().GetBooleanValue("new-checkout", false, &user)
	fmt.Println("new-checkout:", enabled)
}
```

## Learn more

[Concepts](https://github.com/FireWeave-HQ/fireweave-sdk/blob/main/docs/concepts.md) · [Identity](https://github.com/FireWeave-HQ/fireweave-sdk/blob/main/docs/identity.md) · [Testing](https://github.com/FireWeave-HQ/fireweave-sdk/blob/main/docs/testing.md) · [Troubleshooting](https://github.com/FireWeave-HQ/fireweave-sdk/blob/main/docs/troubleshooting.md) · [All SDKs](https://github.com/FireWeave-HQ/fireweave-sdk#quick-start)

## License

[MIT](https://github.com/FireWeave-HQ/fireweave-sdk/blob/main/LICENSE)
