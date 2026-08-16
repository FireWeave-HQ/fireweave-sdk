package ai.fireweave.sdk;

import java.net.URI;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Immutable runtime configuration. Built once, validated by
 * {@link FireweaveRuntime#initialize()}; never mutated afterwards.
 *
 * <p>Secrets ({@code projectApiKey}, {@code personalApiKey}) are never included in
 * {@link #toString()} or error messages.
 */
public final class FireweaveConfig {

    /**
     * Default SSRF host allowlist (security review H-1/L-6; fixture
     * sec-endpoint-ssrf-allowlist): Fireweave production/staging hosts, the five documented
     * PostHog hosts (Java still ships a PostHog injection seam), plus loopback. Custom
     * (self-hosted) hosts require explicit {@link Builder#allowedHosts(Set)} configuration;
     * {@link #ALLOW_ANY_HOST} is the explicit opt-out.
     *
     * <p>Java retains PostHog hosts because {@code fireweave-adapter-posthog} remains a
     * documented seam. Node 2.1 dropped those hosts after removing the vendor adapter
     * (ADR-0006) — that change is not mechanically ported here.
     */
    public static final Set<String> DEFAULT_ALLOWED_HOSTS = Collections.unmodifiableSet(
            new LinkedHashSet<>(Arrays.asList(
                    "app-server.fireweave.ai", "staging-app-server.fireweave.ai",
                    "app.posthog.com", "us.posthog.com", "eu.posthog.com",
                    "us.i.posthog.com", "eu.i.posthog.com",
                    "localhost", "127.0.0.1", "::1")));

    /** Explicit allowlist opt-out entry ("allow any host"); https is still required off-loopback. */
    public static final String ALLOW_ANY_HOST = "*";

    /** Hosts on which plain http is permitted (test servers); everything else requires https. */
    private static final Set<String> LOOPBACK_HOSTS = Collections.unmodifiableSet(
            new LinkedHashSet<>(Arrays.asList("localhost", "127.0.0.1", "::1")));

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
     * explicitly-set-but-blank project API key, unparseable host, non-http(s) scheme, plain
     * http off-loopback, or host outside the SSRF allowlist (deny-by-default; the explicit
     * {@link #ALLOW_ANY_HOST} entry opts out of host pinning but never of the https rule).
     * Messages never echo the key or the host.
     */
    void validate() throws FireweaveException {
        if (projectApiKey != null && projectApiKey.trim().isEmpty()) {
            throw new FireweaveException(ErrorKind.Configuration, "invalid configuration");
        }
        if (host != null) {
            URI uri;
            try {
                uri = URI.create(host);
            } catch (IllegalArgumentException e) {
                throw new FireweaveException(ErrorKind.Configuration, "invalid configuration", e);
            }
            String h = normalizeHost(uri.getHost());
            if (h == null || h.isEmpty()) {
                throw new FireweaveException(ErrorKind.Configuration, "invalid configuration");
            }
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            boolean loopback = LOOPBACK_HOSTS.contains(h);
            // https required for non-loopback hosts; plain http only on loopback (L-3).
            if (!"https".equals(scheme) && !("http".equals(scheme) && loopback)) {
                throw new FireweaveException(ErrorKind.Configuration, "invalid configuration");
            }
            if (!allowedHosts.contains(ALLOW_ANY_HOST) && !containsHost(allowedHosts, h)) {
                throw new FireweaveException(ErrorKind.Configuration, "invalid configuration");
            }
        }
    }

    /** Lowercase + strip IPv6 brackets so "[::1]" matches the "::1" allowlist entry. */
    private static String normalizeHost(String h) {
        if (h == null) {
            return null;
        }
        String out = h.toLowerCase(Locale.ROOT);
        if (out.startsWith("[") && out.endsWith("]")) {
            out = out.substring(1, out.length() - 1);
        }
        return out;
    }

    private static boolean containsHost(Set<String> allowed, String normalizedHost) {
        for (String entry : allowed) {
            if (normalizedHost.equals(normalizeHost(entry))) {
                return true;
            }
        }
        return false;
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
