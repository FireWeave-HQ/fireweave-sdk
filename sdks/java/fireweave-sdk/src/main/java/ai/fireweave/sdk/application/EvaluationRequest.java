package ai.fireweave.sdk.application;

import ai.fireweave.sdk.domain.EvaluationContext;
import ai.fireweave.sdk.domain.FlagType;
import ai.fireweave.sdk.domain.JsonValue;

import java.util.Objects;

/** Immutable evaluation request passed from the runtime to a {@link BackendAdapter}. */
public final class EvaluationRequest {

    private final String flagKey;
    private final FlagType type;
    private final JsonValue defaultValue;
    private final EvaluationContext context;
    private final EvaluationOptions options;

    public EvaluationRequest(String flagKey,
                             FlagType type,
                             JsonValue defaultValue,
                             EvaluationContext context,
                             EvaluationOptions options) {
        this.flagKey = Objects.requireNonNull(flagKey, "flagKey");
        this.type = Objects.requireNonNull(type, "type");
        this.defaultValue = Objects.requireNonNull(defaultValue, "defaultValue");
        this.context = Objects.requireNonNull(context, "context");
        this.options = options == null ? EvaluationOptions.defaults() : options;
    }

    public String flagKey() {
        return flagKey;
    }

    public FlagType type() {
        return type;
    }

    public JsonValue defaultValue() {
        return defaultValue;
    }

    public EvaluationContext context() {
        return context;
    }

    public EvaluationOptions options() {
        return options;
    }
}
