package ai.fireweave.sdk.start;

import ai.fireweave.sdk.domain.Mode;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Consumer;
import java.util.function.Function;

/**
 * Options for {@link Fw#start(StartOptions)}. Every field is optional; {@link #defaults()} reads
 * everything from the environment. Immutable.
 *
 * <p>Each value resolves as: the option here, then the {@code FIREWEAVE_*} variable, then the
 * legacy {@code FW_*} name (one warning), then the default. Empty and whitespace-only values count
 * as unset, options included.
 *
 * <pre>{@code
 * Fw.start(StartOptions.builder().controlPoints(FireweaveControlPoints.CONTROL_POINTS).build());
 * }</pre>
 */
public final class StartOptions {

    private static final StartOptions DEFAULTS = builder().build();

    private final LocalControlPoints controlPoints;
    private final Mode mode;
    private final String environment;
    private final String url;
    private final String key;
    private final String instanceId;
    private final Function<String, String> env;
    private final Consumer<String> log;

    private StartOptions(Builder b) {
        this.controlPoints = b.controlPoints == null ? LocalControlPoints.none() : b.controlPoints;
        this.mode = b.mode;
        this.environment = b.environment;
        this.url = b.url;
        this.key = b.key;
        this.instanceId = b.instanceId;
        this.env = b.env;
        this.log = b.log;
    }

    /** No options: everything comes from the environment. */
    public static StartOptions defaults() {
        return DEFAULTS;
    }

    public static Builder builder() {
        return new Builder();
    }

    /** Local values per control point. Applied in local mode only. Never null. */
    public LocalControlPoints controlPoints() {
        return controlPoints;
    }

    /** Forced mode, or null to infer it. */
    public Mode mode() {
        return mode;
    }

    public String environment() {
        return environment;
    }

    public String url() {
        return url;
    }

    /** The project key, if passed. Never printed by {@link #toString()}. */
    public String key() {
        return key;
    }

    public String instanceId() {
        return instanceId;
    }

    /** The variable lookup used instead of the process environment, or null. */
    public Function<String, String> env() {
        return env;
    }

    /** The sink for {@code [fireweave]} lines, or null for {@code System.getLogger("ai.fireweave")}. */
    public Consumer<String> log() {
        return log;
    }

    @Override
    public String toString() {
        return "StartOptions{controlPoints=" + controlPoints.size()
                + ", mode=" + mode
                + ", environment=" + environment
                + ", url=" + url
                + ", key=" + (key == null ? "null" : "[REDACTED]")
                + ", instanceId=" + instanceId
                + ", env=" + (env == null ? "process" : "custom")
                + ", log=" + (log == null ? "System.Logger" : "custom") + "}";
    }

    public static final class Builder {
        private LocalControlPoints controlPoints;
        private Mode mode;
        private String environment;
        private String url;
        private String key;
        private String instanceId;
        private Function<String, String> env;
        private Consumer<String> log;

        private Builder() {
        }

        /** Every control point the app reads, with its local value ({@link Fw#defineControlPoints}). */
        public Builder controlPoints(LocalControlPoints controlPoints) {
            this.controlPoints = controlPoints;
            return this;
        }

        /**
         * Forces a mode. Null (the default) infers it: a key means remote; no key means local only
         * when the environment name is development, dev, local or test. {@code LOCAL} ignores any
         * key (one warning); {@code REMOTE} without a key is a start error.
         */
        public Builder mode(Mode mode) {
            this.mode = mode;
            return this;
        }

        /**
         * The environment name used to infer the mode, instead of {@code FIREWEAVE_ENV} or
         * {@code APP_ENV}. Pass your own, e.g. a deploy-stage setting.
         */
        public Builder environment(String environment) {
            this.environment = environment;
            return this;
        }

        /**
         * The fw-server endpoint. Default: {@code FIREWEAVE_URL}, else this SDK build's channel
         * host. https is required except on localhost.
         */
        public Builder url(String url) {
            this.url = url;
            return this;
        }

        /** The project key ({@code project-api-key_…}). Default: {@code FIREWEAVE_KEY}. */
        public Builder key(String key) {
            this.key = key;
            return this;
        }

        /**
         * The value of {@link Fw#instanceKey()}. Default: {@code FIREWEAVE_INSTANCE_ID}, else a
         * hash of the host name.
         */
        public Builder instanceId(String instanceId) {
            this.instanceId = instanceId;
            return this;
        }

        /**
         * Replaces the process environment for every variable the start profile reads: tests, and
         * apps that own their config source (Spring: {@code env::getProperty}). Return null for an
         * unset variable and apply no defaults of your own.
         */
        public Builder env(Function<String, String> env) {
            this.env = env;
            return this;
        }

        /** {@link #env(Function)} over a fixed map (copied). */
        public Builder env(Map<String, String> env) {
            if (env == null) {
                this.env = null;
                return this;
            }
            Map<String, String> copy = Collections.unmodifiableMap(new LinkedHashMap<>(env));
            this.env = copy::get;
            return this;
        }

        /**
         * Receives every {@code [fireweave]} line: warnings, the local-mode line and the local
         * registerTarget trace. Default: {@code System.getLogger("ai.fireweave")}, warnings at
         * WARNING and the rest at INFO. Not part of the idempotency check.
         */
        public Builder log(Consumer<String> log) {
            this.log = log;
            return this;
        }

        public StartOptions build() {
            return new StartOptions(this);
        }
    }
}
