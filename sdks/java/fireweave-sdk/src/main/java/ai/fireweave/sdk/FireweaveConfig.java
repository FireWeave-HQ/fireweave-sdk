package ai.fireweave.sdk;

import java.net.URI;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * Immutable runtime configuration. Built once, validated by
 * {@link FireweaveRuntime#initialize()}; never mutated afterwards.
 *
 * <p>Secrets ({@code projectApiKey}, {@code personalApiKey}) are never included in
 * {@link #toString()} or error messages.
 */
public final class FireweaveConfig {

    /** Default SSRF host allowlist (fixture sec-endpoint-ssrf-allowlist). */
    public static final Set<String> DEFAULT_ALLOWED_HOSTS = Collections.unmodifiableSet(
            new LinkedHashSet<>(Arrays.asList("127.0.0.1", "localhost", "us.i.posthog.com", "eu.i.posthog.com")));

    public static final int DEFAULT_REQUEST_TIMEOUT_MS = 3000;
    public static final int DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;

    private final String projectApiKey;
    private final String personalApiKey;
    private final String host;
    private final Set<String> allowedHosts;
    private final boolean requireTargetingKey;
    private final ContextLimits limits;
    private final Set<String> reservedAttributeKeys;
    private final EvaluationContext globalContext;
    private final boolean localEvaluation;
    private final boolean onlyEvaluateLocally;
    private final int requestTimeoutMs;
    private final int shutdownTimeoutMs;
    private final EvaluationOptions defaultEvaluationOptions;
    private final Set<String> telemetryAttributeAllowlist;
    private final boolean releasesEnabled;
    private final boolean exposuresEnabled;
    private final boolean signalsEnabled;

    private FireweaveConfig(Builder b) {
        this.projectApiKey = b.projectApiKey;
        this.personalApiKey = b.personalApiKey;
        this.host = b.host;
        this.allowedHosts = Collections.unmodifiableSet(new LinkedHashSet<>(b.allowedHosts));
        this.requireTargetingKey = b.requireTargetingKey;
        this.limits = b.limits;
        this.reservedAttributeKeys = Collections.unmodifiableSet(new LinkedHashSet<>(b.reservedAttributeKeys));
        this.globalContext = b.globalContext;
        this.localEvaluation = b.localEvaluation;
        this.onlyEvaluateLocally = b.onlyEvaluateLocally;
        this.requestTimeoutMs = b.requestTimeoutMs;
        this.shutdownTimeoutMs = b.shutdownTimeoutMs;
        this.defaultEvaluationOptions = b.defaultEvaluationOptions;
        this.telemetryAttributeAllowlist = b.telemetryAttributeAllowlist == null
                ? null
                : Collections.unmodifiableSet(new LinkedHashSet<>(b.telemetryAttributeAllowlist));
        this.releasesEnabled = b.releasesEnabled;
        this.exposuresEnabled = b.exposuresEnabled;
        this.signalsEnabled = b.signalsEnabled;
    }

    public static Builder builder() {
        return new Builder();
    }

    /**
     * Structural validation. Throws {@code Configuration} (mapped to PROVIDER_FATAL) on:
     * explicitly-set-but-blank project API key, unparseable host, or host outside the SSRF
     * allowlist. Messages never echo the key.
     */
    void validate() throws FireweaveException {
        if (projectApiKey != null && projectApiKey.trim().isEmpty()) {
            throw new FireweaveException(ErrorKind.Configuration, "invalid configuration");
        }
        if (host != null) {
            String h;
            try {
                h = URI.create(host).getHost();
            } catch (IllegalArgumentException e) {
                throw new FireweaveException(ErrorKind.Configuration, "invalid configuration", e);
            }
            if (h == null || h.isEmpty()) {
                throw new FireweaveException(ErrorKind.Configuration, "invalid configuration");
            }
            if (!allowedHosts.isEmpty() && !allowedHosts.contains(h)) {
                throw new FireweaveException(ErrorKind.Configuration, "invalid configuration");
            }
        }
    }

    public String projectApiKey() {
        return projectApiKey;
    }

    public String personalApiKey() {
        return personalApiKey;
    }

    public String host() {
        return host;
    }

    public Set<String> allowedHosts() {
        return allowedHosts;
    }

    public boolean requireTargetingKey() {
        return requireTargetingKey;
    }

    public ContextLimits limits() {
        return limits;
    }

    public Set<String> reservedAttributeKeys() {
        return reservedAttributeKeys;
    }

    public EvaluationContext globalContext() {
        return globalContext;
    }

    public boolean localEvaluation() {
        return localEvaluation;
    }

    public boolean onlyEvaluateLocally() {
        return onlyEvaluateLocally;
    }

    public int requestTimeoutMs() {
        return requestTimeoutMs;
    }

    public int shutdownTimeoutMs() {
        return shutdownTimeoutMs;
    }

    public EvaluationOptions defaultEvaluationOptions() {
        return defaultEvaluationOptions;
    }

    /** Null means "allow all attributes"; non-null filters signal attributes to the allowlist. */
    public Set<String> telemetryAttributeAllowlist() {
        return telemetryAttributeAllowlist;
    }

    public boolean releasesEnabled() {
        return releasesEnabled;
    }

    public boolean exposuresEnabled() {
        return exposuresEnabled;
    }

    public boolean signalsEnabled() {
        return signalsEnabled;
    }

    @Override
    public String toString() {
        return "FireweaveConfig{projectApiKey=" + (projectApiKey == null ? "null" : Redaction.REDACTED)
                + ", host=" + host + ", localEvaluation=" + localEvaluation + "}";
    }

    public static final class Builder {
        private String projectApiKey;
        private String personalApiKey;
        private String host;
        private Set<String> allowedHosts = DEFAULT_ALLOWED_HOSTS;
        private boolean requireTargetingKey;
        private ContextLimits limits = ContextLimits.canonical();
        private Set<String> reservedAttributeKeys = Collections.emptySet();
        private EvaluationContext globalContext = EvaluationContext.empty();
        private boolean localEvaluation;
        private boolean onlyEvaluateLocally;
        private int requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
        private int shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS;
        private EvaluationOptions defaultEvaluationOptions = EvaluationOptions.defaults();
        private Set<String> telemetryAttributeAllowlist;
        private boolean releasesEnabled = true;
        private boolean exposuresEnabled = true;
        private boolean signalsEnabled = true;

        public Builder projectApiKey(String v) {
            this.projectApiKey = v;
            return this;
        }

        public Builder personalApiKey(String v) {
            this.personalApiKey = v;
            return this;
        }

        public Builder host(String v) {
            this.host = v;
            return this;
        }

        public Builder allowedHosts(Set<String> v) {
            this.allowedHosts = v;
            return this;
        }

        public Builder requireTargetingKey(boolean v) {
            this.requireTargetingKey = v;
            return this;
        }

        public Builder limits(ContextLimits v) {
            this.limits = v;
            return this;
        }

        public Builder reservedAttributeKeys(Set<String> v) {
            this.reservedAttributeKeys = v;
            return this;
        }

        public Builder globalContext(EvaluationContext v) {
            this.globalContext = v == null ? EvaluationContext.empty() : v;
            return this;
        }

        public Builder localEvaluation(boolean v) {
            this.localEvaluation = v;
            return this;
        }

        public Builder onlyEvaluateLocally(boolean v) {
            this.onlyEvaluateLocally = v;
            return this;
        }

        public Builder requestTimeoutMs(int v) {
            this.requestTimeoutMs = v;
            return this;
        }

        public Builder shutdownTimeoutMs(int v) {
            this.shutdownTimeoutMs = v;
            return this;
        }

        public Builder defaultEvaluationOptions(EvaluationOptions v) {
            this.defaultEvaluationOptions = v == null ? EvaluationOptions.defaults() : v;
            return this;
        }

        public Builder telemetryAttributeAllowlist(Set<String> v) {
            this.telemetryAttributeAllowlist = v;
            return this;
        }

        public Builder releasesEnabled(boolean v) {
            this.releasesEnabled = v;
            return this;
        }

        public Builder exposuresEnabled(boolean v) {
            this.exposuresEnabled = v;
            return this;
        }

        public Builder signalsEnabled(boolean v) {
            this.signalsEnabled = v;
            return this;
        }

        public FireweaveConfig build() {
            return new FireweaveConfig(this);
        }
    }
}
