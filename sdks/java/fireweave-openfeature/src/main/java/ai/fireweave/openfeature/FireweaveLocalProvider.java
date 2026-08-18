package ai.fireweave.openfeature;

import ai.fireweave.sdk.FireweaveConfig;
import ai.fireweave.sdk.FireweaveLocalAdapter;
import ai.fireweave.sdk.FireweaveRuntime;
import ai.fireweave.sdk.Reasons;
import dev.openfeature.sdk.ErrorCode;
import dev.openfeature.sdk.EvaluationContext;
import dev.openfeature.sdk.FeatureProvider;
import dev.openfeature.sdk.Metadata;
import dev.openfeature.sdk.ProviderEvaluation;
import dev.openfeature.sdk.Value;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.function.LongSupplier;

/**
 * OpenFeature provider for the DEV branch of a scaffolded harness.
 *
 * <p>Wires {@link FireweaveLocalAdapter} through the ordinary
 * {@link FireweaveRuntime} + {@link FireweaveProvider} stack, then applies one
 * narrow rewrite on the way out: {@code FLAG_NOT_FOUND} becomes a clean
 * {@code DEFAULT} resolution. Real defects ({@code PROVIDER_NOT_READY},
 * {@code INVALID_CONTEXT}, {@code TYPE_MISMATCH}, {@code PROVIDER_FATAL}) pass
 * through untouched.
 *
 * <p>No network, no credentials. Metadata name is {@code fireweave-local}.
 */
public final class FireweaveLocalProvider implements FeatureProvider, AutoCloseable {

    public static final String PROVIDER_NAME = "fireweave-local";

    private static final List<FwLocalCapture> CAPTURES =
            Collections.synchronizedList(new ArrayList<>());

    private final FireweaveProvider inner;
    private final boolean echo;
    private final LongSupplier now;

    private FireweaveLocalProvider(Map<String, Boolean> devFlags, boolean echo, LongSupplier now) {
        FireweaveLocalAdapter adapter = new FireweaveLocalAdapter(devFlags);
        FireweaveRuntime runtime = new FireweaveRuntime(FireweaveConfig.builder().build(), adapter);
        this.inner = new FireweaveProvider(runtime);
        this.echo = echo;
        this.now = now == null ? System::currentTimeMillis : now;
    }

    /** Build with boolean overrides only. */
    public static FireweaveLocalProvider create(Map<String, Boolean> devFlags) {
        return create(Options.builder().devFlags(devFlags).build());
    }

    public static FireweaveLocalProvider create() {
        return create(Options.builder().build());
    }

    public static FireweaveLocalProvider create(Options options) {
        Objects.requireNonNull(options, "options");
        return new FireweaveLocalProvider(options.devFlags, options.echo, options.now);
    }

    /** Every evaluation observed through a local provider in this JVM. */
    public static List<FwLocalCapture> getCaptures() {
        synchronized (CAPTURES) {
            return Collections.unmodifiableList(new ArrayList<>(CAPTURES));
        }
    }

    /** Clear the capture buffer (call between tests). */
    public static void resetCaptures() {
        synchronized (CAPTURES) {
            CAPTURES.clear();
        }
    }

    public FireweaveRuntime runtime() {
        return inner.runtime();
    }

    @Override
    public Metadata getMetadata() {
        return () -> PROVIDER_NAME;
    }

    @Override
    public void initialize(EvaluationContext evaluationContext) {
        inner.initialize(evaluationContext);
    }

    @Override
    public void shutdown() {
        inner.shutdown();
    }

    @Override
    public void close() {
        shutdown();
    }

    @Override
    public ProviderEvaluation<Boolean> getBooleanEvaluation(String key, Boolean defaultValue,
                                                            EvaluationContext ctx) {
        return finish("boolean", key, defaultValue,
                inner.getBooleanEvaluation(key, defaultValue, ctx));
    }

    @Override
    public ProviderEvaluation<String> getStringEvaluation(String key, String defaultValue,
                                                          EvaluationContext ctx) {
        return finish("string", key, defaultValue,
                inner.getStringEvaluation(key, defaultValue, ctx));
    }

    @Override
    public ProviderEvaluation<Integer> getIntegerEvaluation(String key, Integer defaultValue,
                                                            EvaluationContext ctx) {
        return finish("integer", key, defaultValue,
                inner.getIntegerEvaluation(key, defaultValue, ctx));
    }

    @Override
    public ProviderEvaluation<Double> getDoubleEvaluation(String key, Double defaultValue,
                                                          EvaluationContext ctx) {
        return finish("double", key, defaultValue,
                inner.getDoubleEvaluation(key, defaultValue, ctx));
    }

    @Override
    public ProviderEvaluation<Value> getObjectEvaluation(String key, Value defaultValue,
                                                         EvaluationContext ctx) {
        return finish("object", key, defaultValue,
                inner.getObjectEvaluation(key, defaultValue, ctx));
    }

    private <T> ProviderEvaluation<T> finish(String type, String flagKey, T defaultValue,
                                             ProviderEvaluation<T> details) {
        ProviderEvaluation<T> resolved = details;
        if (details.getErrorCode() == ErrorCode.FLAG_NOT_FOUND) {
            resolved = ProviderEvaluation.<T>builder()
                    .value(defaultValue)
                    .variant("default")
                    .reason(Reasons.DEFAULT)
                    .build();
        }
        record(type, flagKey, resolved.getValue(),
                resolved.getReason() == null ? "UNKNOWN" : resolved.getReason());
        return resolved;
    }

    private void record(String type, String flagKey, Object value, String reason) {
        FwLocalCapture capture = new FwLocalCapture(flagKey, type, value, reason, now.getAsLong());
        CAPTURES.add(capture);
        if (echo) {
            System.out.println("[fw-local] " + type + " " + flagKey + " = " + value + " (" + reason + ")");
        }
    }

    /** Construction options for {@link FireweaveLocalProvider#create(Options)}. */
    public static final class Options {
        private final Map<String, Boolean> devFlags;
        private final boolean echo;
        private final LongSupplier now;

        private Options(Map<String, Boolean> devFlags, boolean echo, LongSupplier now) {
            this.devFlags = Collections.unmodifiableMap(new LinkedHashMap<>(
                    devFlags == null ? Collections.emptyMap() : devFlags));
            this.echo = echo;
            this.now = now;
        }

        public static Builder builder() {
            return new Builder();
        }

        public static final class Builder {
            private Map<String, Boolean> devFlags = Collections.emptyMap();
            private boolean echo;
            private LongSupplier now;

            public Builder devFlags(Map<String, Boolean> devFlags) {
                this.devFlags = devFlags;
                return this;
            }

            /** Print one line per evaluation to stdout (opt-in). */
            public Builder echo(boolean echo) {
                this.echo = echo;
                return this;
            }

            /** Test clock; defaults to {@link System#currentTimeMillis()}. */
            public Builder now(LongSupplier now) {
                this.now = now;
                return this;
            }

            public Options build() {
                return new Options(devFlags, echo, now);
            }
        }
    }
}
