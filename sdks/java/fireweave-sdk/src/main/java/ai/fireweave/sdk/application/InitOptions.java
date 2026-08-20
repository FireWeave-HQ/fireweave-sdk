package ai.fireweave.sdk.application;

import ai.fireweave.sdk.domain.Mode;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;

/**
 * Options for {@link Fireweave#init}, mirroring node's {@code InitFireweaveOptions} /
 * python's {@code init_fireweave(**options)} (spec/modes.md).
 *
 * <p>Both local- and remote-mode fields live on the SAME type rather than two disjoint
 * subtypes, deliberately: spec/modes.md's initialisation-validation table has a row for
 * "{@code mode: 'local'} with credentials supplied" (a config half-migrated from remote to
 * local reads as neither, silently, unless rejected) — that row is only reachable when a caller
 * CAN construct a value carrying both a mode and left-over credentials, which two disjoint
 * builder types would prevent by construction. A single type, checked by
 * {@code Validation.validateInitOptions}, is what makes the row testable and reachable exactly
 * like it is in node/python.
 */
public final class InitOptions {

    private final Mode mode;
    private final String apiKey;
    private final String apiUrl;
    private final Set<String> allowedHosts;
    private final Map<String, Boolean> controlPoints;
    private final Consumer<String> log;

    private InitOptions(Builder b) {
        this.mode = b.mode;
        this.apiKey = b.apiKey;
        this.apiUrl = b.apiUrl;
        this.allowedHosts = b.allowedHosts;
        this.controlPoints = b.controlPoints == null
                ? Collections.emptyMap()
                : Collections.unmodifiableMap(new LinkedHashMap<>(b.controlPoints));
        this.log = b.log;
    }

    /** Evaluate against fw-server over the network (spec/remote-protocol.md). */
    public static InitOptions remote(String apiKey, String apiUrl) {
        return builder(Mode.REMOTE).apiKey(apiKey).apiUrl(apiUrl).build();
    }

    /** Evaluate against an in-process seeded map; no network (spec/modes.md). */
    public static InitOptions local() {
        return builder(Mode.LOCAL).build();
    }

    /** Evaluate against an in-process seeded map; no network (spec/modes.md). */
    public static InitOptions local(Map<String, Boolean> controlPoints) {
        return builder(Mode.LOCAL).controlPoints(controlPoints).build();
    }

    /**
     * {@code mode} is nullable so a caller can construct a deliberately-invalid value (e.g. one
     * assembled from a config file that never set it) for {@code Validation.validateInitOptions}
     * to reject as {@code Configuration} — spec/modes.md "mode absent" — rather than the SDK
     * inferring a mode by its absence.
     */
    public static Builder builder(Mode mode) {
        return new Builder(mode);
    }

    public Mode mode() {
        return mode;
    }

    /** Fireweave project/runtime key. Required for {@link Mode#REMOTE} — never read from env. */
    public String apiKey() {
        return apiKey;
    }

    /** fw-server base URL. Required for {@link Mode#REMOTE} — never read from env. */
    public String apiUrl() {
        return apiUrl;
    }

    /**
     * SSRF allowlist override (spec/modes.md "apiUrl fails the host allowlist"). Null means the
     * canonical default ({@link FireweaveConfig#DEFAULT_ALLOWED_HOSTS}).
     */
    public Set<String> allowedHosts() {
        return allowedHosts;
    }

    /**
     * Per-key boolean overrides — the seeded local map (Mode.LOCAL only). A present key resolves
     * with reason {@code STATIC}; an absent key misses so the caller's own default is used. May
     * be empty. Never null.
     */
    public Map<String, Boolean> controlPoints() {
        return controlPoints;
    }

    /**
     * Sink for the {@code [fireweave:local]} registerTarget trace line (spec/modes.md
     * "registerTarget in local mode", Mode.LOCAL only). Null means the adapter's own default.
     */
    public Consumer<String> log() {
        return log;
    }

    public static final class Builder {
        private final Mode mode;
        private String apiKey;
        private String apiUrl;
        private Set<String> allowedHosts;
        private Map<String, Boolean> controlPoints;
        private Consumer<String> log;

        private Builder(Mode mode) {
            this.mode = mode;
        }

        public Builder apiKey(String v) {
            this.apiKey = v;
            return this;
        }

        public Builder apiUrl(String v) {
            this.apiUrl = v;
            return this;
        }

        public Builder allowedHosts(Set<String> v) {
            this.allowedHosts = v;
            return this;
        }

        public Builder controlPoints(Map<String, Boolean> v) {
            this.controlPoints = v;
            return this;
        }

        public Builder log(Consumer<String> v) {
            this.log = v;
            return this;
        }

        public InitOptions build() {
            return new InitOptions(this);
        }
    }
}
