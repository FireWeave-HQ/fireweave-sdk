package ai.fireweave.sdk;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Optional fields for {@code POST /v1/targets/register}
 * ({@code spec/remote-register-target.schema.json}).
 *
 * <p>Unset fields are left off the wire rather than sent as null — the server
 * defaults {@code kind} to {@code user} when absent. Immutable and thread-safe.
 */
public final class RegisterTargetOptions {

    private static final RegisterTargetOptions EMPTY = new RegisterTargetOptions(null, null, null);

    private final TargetKind kind;
    private final String environment;
    private final Map<String, JsonValue> properties;

    private RegisterTargetOptions(TargetKind kind, String environment, Map<String, JsonValue> properties) {
        this.kind = kind;
        this.environment = environment;
        this.properties = properties == null || properties.isEmpty()
                ? Collections.emptyMap()
                : Collections.unmodifiableMap(new LinkedHashMap<>(properties));
    }

    public static RegisterTargetOptions empty() {
        return EMPTY;
    }

    public static Builder builder() {
        return new Builder();
    }

    /** {@code user} or {@code device}, or {@code null} to omit (server default {@code user}). */
    public TargetKind kind() {
        return kind;
    }

    /** Client-declared environment, or {@code null} to omit. */
    public String environment() {
        return environment;
    }

    /** Durable targeting facts. Empty when omitted. Never null. */
    public Map<String, JsonValue> properties() {
        return properties;
    }

    public static final class Builder {
        private TargetKind kind;
        private String environment;
        private Map<String, JsonValue> properties;

        public Builder kind(TargetKind kind) {
            this.kind = kind;
            return this;
        }

        public Builder environment(String environment) {
            this.environment = environment;
            return this;
        }

        public Builder properties(Map<String, JsonValue> properties) {
            this.properties = properties;
            return this;
        }

        public Builder property(String key, JsonValue value) {
            Objects.requireNonNull(key, "key");
            if (this.properties == null) {
                this.properties = new LinkedHashMap<>();
            }
            this.properties.put(key, value);
            return this;
        }

        public RegisterTargetOptions build() {
            return new RegisterTargetOptions(kind, environment, properties);
        }
    }
}
