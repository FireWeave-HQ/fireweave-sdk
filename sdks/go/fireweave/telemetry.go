package fireweave

// telemetryAllowedKeys is the allowlist of property keys the SDK will emit
// on telemetry events. Anything else (arbitrary context attributes, PII) is
// dropped before an event leaves the process.
var telemetryAllowedKeys = map[string]struct{}{
	"flagKey":     {},
	"variant":     {},
	"value":       {},
	"rolloutId":   {},
	"changeId":    {},
	"stampId":     {},
	"stampIds":    {},
	"status":      {},
	"name":        {},
	"kind":        {},
	"errorKind":   {},
	"message":     {},
	"metricValue": {},
}

// sanitizeTelemetryProperties applies the allowlist, drops empty values,
// and redacts every string value.
func sanitizeTelemetryProperties(props map[string]any) map[string]any {
	out := make(map[string]any, len(props))
	for k, v := range props {
		if _, ok := telemetryAllowedKeys[k]; !ok {
			continue
		}
		if s, ok := v.(string); ok {
			if s == "" {
				continue
			}
			v = Redact(s)
		}
		out[k] = v
	}
	return out
}
