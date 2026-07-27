package ai.fireweave.adapter.posthog;

import ai.fireweave.sdk.BackendAdapter;
import ai.fireweave.sdk.Decision;
import ai.fireweave.sdk.ErrorKind;
import ai.fireweave.sdk.EvaluationContext;
import ai.fireweave.sdk.EvaluationRequest;
import ai.fireweave.sdk.Exposure;
import ai.fireweave.sdk.FireweaveConfig;
import ai.fireweave.sdk.FireweaveException;
import ai.fireweave.sdk.FlagType;
import ai.fireweave.sdk.JsonValue;
import ai.fireweave.sdk.Reasons;
import ai.fireweave.sdk.Signal;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * PostHog-backed {@link BackendAdapter} (ADR-0002) over the {@link PostHogClientApi} seam.
 *
 * <h2>Modes</h2>
 * Remote evaluation with a {@code phc_} project key; local evaluation when a {@code phs_}/
 * {@code phx_} personal key is configured with {@code localEvaluation=true}. The mode is
 * reported via {@link #runtimeFeatures()}.
 *
 * <h2>Ownership</h2>
 * {@code owned=true} means the adapter created the client and closes it on shutdown; an
 * injected client ({@code owned=false}) is never closed by the adapter (DI-friendly).
 *
 * <h2>Staleness neutralization</h2>
 * The vendor Java SDK caches remote per-user flag results for up to 5 minutes and keeps
 * last-good local definitions after failed polls. Snapshots carry {@code ageMs}; results older
 * than {@link #staleThresholdMs} resolve with reason {@code STALE} plus
 * {@code fireweave.fromCache} metadata, and {@link #isStale()} turns true so the runtime surfaces
 * lifecycle STALE — stale data is never silently reported fresh.
 *
 * <h2>ThreadLocal neutralization</h2>
 * All identity/properties are passed explicitly per call through the seam; the vendor SDK's
 * ThreadLocal request context is never used.
 *
 * <h2>Exposure dedup / quotaLimited</h2>
 * {@code $feature_flag_called} exposures are deduped on (distinctId, flagKey, variant, value).
 * A {@code quotaLimited} /flags body containing {@code feature_flags} resolves as
 * {@code FlagNotFound} with {@code fireweave.quotaLimited=true} metadata (defaults served,
 * nothing thrown to callers).
 *
 * <p><b>No vendor types in the public API</b> — enforced by the reflective signature scan test.
 * Thread-safe (immutable config + concurrent dedup set; client must be thread-safe).
 */
public final class PostHogAdapter implements BackendAdapter {

    public static final long DEFAULT_STALE_THRESHOLD_MS = 5 * 60 * 1000;

    private final PostHogClientApi client;
    private final boolean owned;
    private final long staleThresholdMs;
    private final Set<String> exposureDedup = ConcurrentHashMap.newKeySet();
    private volatile boolean localEvaluation;
    private volatile boolean stale;
    private volatile boolean shutdown;

    /** Wrap an injected (caller-owned) client. */
    public PostHogAdapter(PostHogClientApi client) {
        this(client, false, DEFAULT_STALE_THRESHOLD_MS);
    }

    public PostHogAdapter(PostHogClientApi client, boolean owned, long staleThresholdMs) {
        this.client = Objects.requireNonNull(client, "client");
        this.owned = owned;
        this.staleThresholdMs = staleThresholdMs;
    }

    /**
     * Config-owned client construction is BLOCKED: {@code com.posthog:posthog-server:2.9.0} is
     * not published to Maven Central (verified 2026-07-27), and the legacy 1.x SDK is prohibited.
     * Inject a {@link PostHogClientApi} until the artifact lands.
     */
    public static PostHogAdapter create(FireweaveConfig config) throws FireweaveException {
        throw new FireweaveException(ErrorKind.UnsupportedCapability,
                "posthog-server client binding unavailable: com.posthog:posthog-server:2.9.0 "
                        + "is not published to Maven Central; inject a PostHogClientApi");
    }

    @Override
    public String name() {
        return "posthog";
    }

    @Override
    public void initialize(FireweaveConfig config) throws FireweaveException {
        String key = config.projectApiKey();
        boolean local = config.localEvaluation();
        if (local) {
            String personal = config.personalApiKey();
            if (personal == null || !(personal.startsWith("phs_") || personal.startsWith("phx_"))) {
                throw new FireweaveException(ErrorKind.Configuration,
                        "local evaluation requires a personal API key (phs_/phx_)");
            }
        }
        if (key == null || !key.startsWith("phc_")) {
            throw new FireweaveException(ErrorKind.Configuration, "invalid configuration");
        }
        this.localEvaluation = local;
    }

    @Override
    public Decision evaluate(EvaluationRequest request) throws FireweaveException {
        if (shutdown) {
            throw new FireweaveException(ErrorKind.AlreadyClosed);
        }
        EvaluationContext ctx = request.context();
        String distinctId = ctx.targetingKey();
        if (distinctId == null || distinctId.isEmpty()) {
            // PostHog cannot evaluate without a distinct_id regardless of requireTargetingKey.
            throw FireweaveException.targetingKeyMissing();
        }

        PostHogFlagsSnapshot snapshot;
        try {
            snapshot = client.evaluateFlags(distinctId, ctx.attributes(), ctx.groups(), ctx.groupProperties());
        } catch (PostHogTransportException e) {
            throw mapTransport(e);
        } catch (RuntimeException e) {
            throw new FireweaveException(ErrorKind.Internal, ErrorKind.Internal.defaultMessage(), e);
        }

        if (snapshot.quotaLimited().contains("feature_flags")) {
            throw FireweaveException.quotaLimited();
        }

        PostHogFlagsSnapshot.FlagResult flag = snapshot.flags().get(request.flagKey());
        if (flag == null) {
            throw new FireweaveException(ErrorKind.FlagNotFound);
        }

        JsonValue value = coerce(flag, request.type());
        boolean fromStaleCache = snapshot.ageMs() > staleThresholdMs;
        this.stale = fromStaleCache;

        String reason;
        if (!flag.enabled()) {
            reason = Reasons.DISABLED;
        } else if (fromStaleCache) {
            reason = Reasons.STALE;
        } else {
            reason = Reasons.TARGETING_MATCH;
        }

        Decision.Builder b = Decision.builder(request.flagKey())
                .value(value)
                .variant(flag.variant())
                .reason(reason)
                .payload(flag.payload());
        if (flag.version() != null) {
            b.metadata("fireweave.flagVersion", flag.version());
        }
        if (flag.flagId() != null && flag.conditionIndex() != null) {
            b.metadata("fireweave.vendorFlagId", flag.flagId());
            if (flag.reasonCode() != null) {
                b.metadata("fireweave.reasonCode", flag.reasonCode());
            }
        }
        if (fromStaleCache) {
            b.metadata("fireweave.fromCache", true);
        }
        return b.build();
    }

    /** Map the flag result onto the requested Fireweave type or throw TypeMismatch. */
    private static JsonValue coerce(PostHogFlagsSnapshot.FlagResult flag, FlagType requested)
            throws FireweaveException {
        JsonValue v = flag.value();
        switch (requested) {
            case BOOLEAN:
                if (v == null) {
                    return JsonValue.of(flag.enabled());
                }
                if (v.kind() == JsonValue.Kind.BOOLEAN) {
                    return v;
                }
                break;
            case STRING:
                if (v != null && v.kind() == JsonValue.Kind.STRING) {
                    return v;
                }
                if (v == null && flag.variant() != null) {
                    return JsonValue.of(flag.variant());
                }
                break;
            case INTEGER:
                if (v != null && v.kind() == JsonValue.Kind.NUMBER && v.isIntegralNumber()
                        && !(v.asNumber() instanceof Double || v.asNumber() instanceof Float)) {
                    return v;
                }
                break;
            case FLOAT:
                if (v != null && v.kind() == JsonValue.Kind.NUMBER) {
                    return v;
                }
                break;
            case OBJECT:
                if (v != null && v.kind() == JsonValue.Kind.OBJECT) {
                    return v;
                }
                if (v == null && flag.payload() != null && flag.payload().kind() == JsonValue.Kind.OBJECT) {
                    return flag.payload();
                }
                break;
            default:
                break;
        }
        throw new FireweaveException(ErrorKind.TypeMismatch);
    }

    static FireweaveException mapTransport(PostHogTransportException e) {
        switch (e.kind()) {
            case TIMEOUT:
                return new FireweaveException(ErrorKind.Timeout, ErrorKind.Timeout.defaultMessage(), e);
            case NETWORK:
                return new FireweaveException(ErrorKind.Network, ErrorKind.Network.defaultMessage(), e);
            case MALFORMED_BODY:
                return new FireweaveException(ErrorKind.MalformedResponse,
                        ErrorKind.MalformedResponse.defaultMessage(), e);
            case HTTP:
            default: {
                int s = e.httpStatus();
                if (s == 401) {
                    return new FireweaveException(ErrorKind.Authentication,
                            ErrorKind.Authentication.defaultMessage(), e);
                }
                if (s == 403) {
                    return new FireweaveException(ErrorKind.Authorization,
                            ErrorKind.Authorization.defaultMessage(), e);
                }
                if (s == 429) {
                    return new FireweaveException(ErrorKind.RateLimited,
                            ErrorKind.RateLimited.defaultMessage(), e);
                }
                if (s >= 500) {
                    return new FireweaveException(ErrorKind.BackendUnavailable,
                            ErrorKind.BackendUnavailable.defaultMessage(), e);
                }
                return new FireweaveException(ErrorKind.Network, ErrorKind.Network.defaultMessage(), e);
            }
        }
    }

    @Override
    public void deliverExposure(Exposure exposure) throws FireweaveException {
        if (!exposureDedup.add(exposure.dedupKey())) {
            return; // deduped: identical (subject, flag, variant, value) already captured
        }
        Map<String, JsonValue> props = new LinkedHashMap<>();
        props.put("$feature_flag", JsonValue.of(exposure.flagKey()));
        if (exposure.variant() != null) {
            props.put("$feature_flag_response", JsonValue.of(exposure.variant()));
        }
        props.put("$feature_flag_value", exposure.value());
        if (exposure.rolloutId() != null) {
            props.put("fireweave_rollout_id", JsonValue.of(exposure.rolloutId()));
        }
        try {
            client.capture(exposure.targetingKey(), "$feature_flag_called", props);
        } catch (PostHogTransportException e) {
            throw mapTransport(e);
        }
    }

    @Override
    public void deliverSignal(Signal signal) throws FireweaveException {
        Map<String, JsonValue> props = new LinkedHashMap<>();
        props.put("fireweave_signal_kind", JsonValue.of(signal.kind().canonical()));
        props.put("fireweave_signal_name", JsonValue.of(signal.name()));
        if (signal.status() != null) {
            props.put("status", JsonValue.of(signal.status()));
        }
        if (signal.errorKind() != null) {
            props.put("error_kind", JsonValue.of(signal.errorKind().name()));
        }
        if (signal.message() != null) {
            props.put("message", JsonValue.of(signal.message()));
        }
        if (signal.value() != null) {
            props.put("value", signal.value());
        }
        if (signal.rolloutId() != null) {
            props.put("rollout_id", JsonValue.of(signal.rolloutId()));
        }
        if (signal.changeId() != null) {
            props.put("change_id", JsonValue.of(signal.changeId()));
        }
        if (signal.stampId() != null) {
            props.put("stamp_id", JsonValue.of(signal.stampId()));
        }
        String distinctId = signal.targetingKey() != null ? signal.targetingKey() : "fireweave_sdk";
        try {
            client.capture(distinctId, "fireweave_signal", props);
        } catch (PostHogTransportException e) {
            throw mapTransport(e);
        }
    }

    @Override
    public Map<String, Boolean> runtimeFeatures() {
        Map<String, Boolean> f = new LinkedHashMap<>();
        f.put("remoteEvaluation", !localEvaluation);
        f.put("localEvaluation", localEvaluation);
        f.put("exposureEmission", true);
        f.put("sideEffectFreeReads", true);
        f.put("staleRemoteCache", true);
        return Collections.unmodifiableMap(f);
    }

    @Override
    public boolean isStale() {
        return stale;
    }

    @Override
    public void shutdown() {
        if (shutdown) {
            return;
        }
        shutdown = true;
        if (owned) {
            try {
                client.close();
            } catch (RuntimeException ignored) {
                // shutdown never throws
            }
        }
    }
}
