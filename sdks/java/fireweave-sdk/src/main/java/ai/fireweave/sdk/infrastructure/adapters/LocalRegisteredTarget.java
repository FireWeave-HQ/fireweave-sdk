package ai.fireweave.sdk.infrastructure.adapters;

import ai.fireweave.sdk.domain.JsonValue;
import ai.fireweave.sdk.domain.TargetKind;

import java.util.Map;

/** A target recorded by {@link FireweaveLocalAdapter#registerTarget}. */
public final class LocalRegisteredTarget {

    private final String targetingKey;
    private final TargetKind kind;
    private final Map<String, JsonValue> properties;
    private final String environment;

    LocalRegisteredTarget(String targetingKey, TargetKind kind, Map<String, JsonValue> properties,
                          String environment) {
        this.targetingKey = targetingKey;
        this.kind = kind;
        this.properties = properties;
        this.environment = environment;
    }

    public String targetingKey() {
        return targetingKey;
    }

    public TargetKind kind() {
        return kind;
    }

    public Map<String, JsonValue> properties() {
        return properties;
    }

    /** Client-declared environment, or null. */
    public String environment() {
        return environment;
    }
}
