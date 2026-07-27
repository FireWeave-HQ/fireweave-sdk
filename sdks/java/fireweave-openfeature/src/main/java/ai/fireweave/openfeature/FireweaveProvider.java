package ai.fireweave.openfeature;

import ai.fireweave.sdk.Capabilities;
import ai.fireweave.sdk.Decision;
import ai.fireweave.sdk.ErrorKind;
import ai.fireweave.sdk.FireweaveException;
import ai.fireweave.sdk.FireweaveRuntime;
import ai.fireweave.sdk.FlagType;
import ai.fireweave.sdk.JsonValue;
import ai.fireweave.sdk.Reasons;
import dev.openfeature.sdk.ErrorCode;
import dev.openfeature.sdk.EvaluationContext;
import dev.openfeature.sdk.FeatureProvider;
import dev.openfeature.sdk.ImmutableMetadata;
import dev.openfeature.sdk.Metadata;
import dev.openfeature.sdk.ProviderEvaluation;
import dev.openfeature.sdk.Value;
import dev.openfeature.sdk.exceptions.FatalError;
import dev.openfeature.sdk.exceptions.GeneralError;

import java.util.Map;
import java.util.Objects;
import java.util.function.Function;

/**
 * OpenFeature {@link FeatureProvider} backed by a {@link FireweaveRuntime}.
 *
 * <h2>Semantics</h2>
 * <ul>
 *   <li>All five resolvers supported. <b>Long-clamp limitation:</b> the Java OF integer resolver
 *       is 32-bit {@code Integer}; integral flag values outside {@code Integer} range resolve as
 *       {@code TYPE_MISMATCH} + default rather than silently truncating. Cross-language integer
 *       reliability is documented to 2^53−1 ({@link Capabilities#INT_SAFE_MAX_ABS}); fixture
 *       {@code eval-int-beyond-safe-integer} is skipped-with-documented-limitation for Java.</li>
 *   <li>{@code targetingKey} maps to the backend identity (PostHog {@code distinct_id}).</li>
 *   <li>Resolvers never throw on the normal path: failures return the default with
 *       {@code reason=ERROR}, the mapped OF error code, and {@code fireweave.errorKind} flag
 *       metadata.</li>
 *   <li>{@link #initialize} / {@link #shutdown} drive the runtime lifecycle; a Configuration
 *       failure raises OF {@link FatalError} (PROVIDER_FATAL).</li>
 *   <li>All methods are synchronous — no evaluation path here is genuinely async, so no
 *       {@code CompletionStage} surface is exposed (decision brief).</li>
 * </ul>
 *
 * <h2>Thread-safety</h2>
 * Stateless facade over the thread-safe runtime; safe for concurrent resolution.
 */
public final class FireweaveProvider implements FeatureProvider, AutoCloseable {

    /** How {@link #initialize(EvaluationContext)} treats the runtime. */
    public enum InitMode {
        /** Provider initialize() drives runtime.initialize() (normal OF lifecycle). */
        AUTOMATIC,
        /** Provider initialize() is a no-op; the embedder initializes the runtime explicitly. */
        MANUAL
    }

    private final FireweaveRuntime runtime;
    private final InitMode initMode;

    public FireweaveProvider(FireweaveRuntime runtime) {
        this(runtime, InitMode.AUTOMATIC);
    }

    public FireweaveProvider(FireweaveRuntime runtime, InitMode initMode) {
        this.runtime = Objects.requireNonNull(runtime, "runtime");
        this.initMode = Objects.requireNonNull(initMode, "initMode");
    }

    public FireweaveRuntime runtime() {
        return runtime;
    }

    @Override
    public Metadata getMetadata() {
        return () -> Capabilities.PROVIDER_NAME;
    }

    @Override
    public void initialize(EvaluationContext evaluationContext) {
        if (initMode == InitMode.MANUAL) {
            return;
        }
        try {
            runtime.initialize();
        } catch (FireweaveException e) {
            // Messages are already secret-sanitized by FireweaveException.
            if (e.kind() == ErrorKind.Configuration) {
                throw new FatalError(e.getMessage());
            }
            throw new GeneralError(e.getMessage());
        }
    }

    @Override
    public void shutdown() {
        runtime.shutdown();
    }

    @Override
    public void close() {
        shutdown();
    }

    @Override
    public ProviderEvaluation<Boolean> getBooleanEvaluation(String key, Boolean defaultValue,
                                                            EvaluationContext ctx) {
        Decision d = evaluate(key, FlagType.BOOLEAN, JsonValue.of(defaultValue), ctx);
        return toEvaluation(d, defaultValue,
                v -> v.kind() == JsonValue.Kind.BOOLEAN ? v.asBoolean() : null);
    }

    @Override
    public ProviderEvaluation<String> getStringEvaluation(String key, String defaultValue,
                                                          EvaluationContext ctx) {
        Decision d = evaluate(key, FlagType.STRING, JsonValue.of(defaultValue), ctx);
        return toEvaluation(d, defaultValue,
                v -> v.kind() == JsonValue.Kind.STRING ? v.asString() : null);
    }

    @Override
    public ProviderEvaluation<Integer> getIntegerEvaluation(String key, Integer defaultValue,
                                                            EvaluationContext ctx) {
        Decision d = evaluate(key, FlagType.INTEGER, JsonValue.of(defaultValue), ctx);
        return toEvaluation(d, defaultValue, v -> {
            if (v.kind() != JsonValue.Kind.NUMBER || !v.isIntegralNumber()) {
                return null;
            }
            long l = v.asNumber().longValue();
            if (l > Integer.MAX_VALUE || l < Integer.MIN_VALUE) {
                return null; // Long-clamp limitation: refuse lossy truncation.
            }
            return (int) l;
        });
    }

    @Override
    public ProviderEvaluation<Double> getDoubleEvaluation(String key, Double defaultValue,
                                                          EvaluationContext ctx) {
        Decision d = evaluate(key, FlagType.FLOAT, JsonValue.of(defaultValue), ctx);
        return toEvaluation(d, defaultValue,
                v -> v.kind() == JsonValue.Kind.NUMBER ? v.asNumber().doubleValue() : null);
    }

    @Override
    public ProviderEvaluation<Value> getObjectEvaluation(String key, Value defaultValue,
                                                         EvaluationContext ctx) {
        JsonValue defaultJson = ContextMapper.toJsonValue(defaultValue);
        Decision d = evaluate(key, FlagType.OBJECT, defaultJson, ctx);
        ProviderEvaluation<Value> eval = toEvaluation(d, defaultValue,
                v -> v.isNull() ? null : ContextMapper.toOpenFeatureValue(v));
        return eval;
    }

    private Decision evaluate(String key, FlagType type, JsonValue defaultValue, EvaluationContext ctx) {
        // The OF SDK merges API-global → transaction → client → invocation before this call;
        // config.globalContext (Fireweave-level) is merged first inside the runtime.
        return runtime.evaluate(key, type, defaultValue, null, ContextMapper.fromOpenFeature(ctx), null);
    }

    private <T> ProviderEvaluation<T> toEvaluation(Decision d, T defaultValue,
                                                   Function<JsonValue, T> extractor) {
        ProviderEvaluation.ProviderEvaluationBuilder<T> b = ProviderEvaluation.builder();
        b.reason(d.reason());
        b.flagMetadata(toMetadata(d.flagMetadata()));
        if (d.error() != null) {
            return b.value(defaultValue)
                    .errorCode(mapErrorCode(d.error().openFeatureErrorCode()))
                    .errorMessage(d.error().message())
                    .build();
        }
        T value = extractor.apply(d.value());
        if (value == null && d.value().kind() != JsonValue.Kind.NULL) {
            // Adapter returned a decision whose value shape does not fit the requested type.
            return b.value(defaultValue)
                    .reason(Reasons.ERROR)
                    .errorCode(ErrorCode.TYPE_MISMATCH)
                    .errorMessage(ErrorKind.TypeMismatch.defaultMessage())
                    .flagMetadata(toMetadata(withErrorKind(d.flagMetadata(), ErrorKind.TypeMismatch)))
                    .build();
        }
        return b.value(value == null ? defaultValue : value)
                .variant(d.variant())
                .build();
    }

    private static Map<String, Object> withErrorKind(Map<String, Object> metadata, ErrorKind kind) {
        Map<String, Object> m = new java.util.LinkedHashMap<>(metadata);
        m.put(ErrorKind.FLAG_METADATA_ERROR_KIND_KEY, kind.name());
        return m;
    }

    static ErrorCode mapErrorCode(String canonical) {
        try {
            return ErrorCode.valueOf(canonical);
        } catch (IllegalArgumentException e) {
            return ErrorCode.GENERAL;
        }
    }

    static ImmutableMetadata toMetadata(Map<String, Object> metadata) {
        ImmutableMetadata.ImmutableMetadataBuilder b = ImmutableMetadata.builder();
        for (Map.Entry<String, Object> e : metadata.entrySet()) {
            Object v = e.getValue();
            if (v instanceof Boolean) {
                b.addBoolean(e.getKey(), (Boolean) v);
            } else if (v instanceof Integer) {
                b.addInteger(e.getKey(), (Integer) v);
            } else if (v instanceof Long) {
                b.addLong(e.getKey(), (Long) v);
            } else if (v instanceof Float) {
                b.addFloat(e.getKey(), (Float) v);
            } else if (v instanceof Number) {
                b.addDouble(e.getKey(), ((Number) v).doubleValue());
            } else if (v != null) {
                b.addString(e.getKey(), v.toString());
            }
        }
        return b.build();
    }
}
