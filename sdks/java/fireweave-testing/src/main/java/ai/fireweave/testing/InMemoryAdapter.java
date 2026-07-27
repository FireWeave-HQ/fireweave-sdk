package ai.fireweave.testing;

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
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Deterministic, fixture-driven {@link BackendAdapter}. No I/O, no clocks, no randomness:
 * resolution depends only on the configured {@link FlagDefinition}s, the optional
 * {@link FaultConfig}, and the request. Fault modes are simulated in-process (delay compares
 * against the configured timeout instead of sleeping).
 *
 * <p>Thread-safe: definitions are immutable after construction; recorded exposures/signals use
 * concurrent collections.
 */
public final class InMemoryAdapter implements BackendAdapter {

    private final Map<String, FlagDefinition> flags;
    private final FaultConfig fault;
    private volatile boolean stale;
    private volatile int requestTimeoutMs = FireweaveConfig.DEFAULT_REQUEST_TIMEOUT_MS;
    private final AtomicInteger evaluateCalls = new AtomicInteger();
    private final AtomicReference<EvaluationContext> lastContext = new AtomicReference<>();
    private final List<Exposure> deliveredExposures = new CopyOnWriteArrayList<>();
    private final List<Signal> deliveredSignals = new CopyOnWriteArrayList<>();
    private final Map<String, Boolean> runtimeFeatures = new ConcurrentHashMap<>();

    public InMemoryAdapter(Map<String, FlagDefinition> flags) {
        this(flags, null);
    }

    public InMemoryAdapter(Map<String, FlagDefinition> flags, FaultConfig fault) {
        this.flags = Collections.unmodifiableMap(new LinkedHashMap<>(flags));
        this.fault = fault;
        this.runtimeFeatures.put("sideEffectFreeReads", true);
        this.runtimeFeatures.put("exposureEmission", false);
    }

    @Override
    public String name() {
        return "inmemory";
    }

    @Override
    public void initialize(FireweaveConfig config) throws FireweaveException {
        this.requestTimeoutMs = config.requestTimeoutMs();
    }

    /** Mark the snapshot stale (fixture given.providerState == STALE). */
    public void setStale(boolean stale) {
        this.stale = stale;
    }

    @Override
    public boolean isStale() {
        return stale;
    }

    @Override
    public Decision evaluate(EvaluationRequest request) throws FireweaveException {
        evaluateCalls.incrementAndGet();
        lastContext.set(request.context());

        boolean servingStaleDefinitions = false;
        if (fault != null) {
            servingStaleDefinitions = applyFault();
        }

        FlagDefinition flag = flags.get(request.flagKey());
        if (flag == null) {
            throw new FireweaveException(ErrorKind.FlagNotFound);
        }
        checkType(flag.type(), request.type());

        if (!matches(flag, request.context())) {
            return Decision.builder(request.flagKey())
                    .value(request.defaultValue())
                    .reason(Reasons.DEFAULT)
                    .build();
        }

        String reason;
        if (flag.fireweaveReason() != null) {
            reason = flag.fireweaveReason();
        } else if (!flag.enabled()) {
            reason = Reasons.DISABLED;
        } else if (flag.fromCache() || servingStaleDefinitions || stale) {
            reason = Reasons.STALE;
        } else {
            reason = Reasons.TARGETING_MATCH;
        }

        Decision.Builder b = Decision.builder(request.flagKey())
                .value(flag.value())
                .variant(flag.variant())
                .reason(reason)
                .payload(flag.payload());
        if (flag.metadataVersion() != null) {
            b.metadata("fireweave.flagVersion", flag.metadataVersion());
        }
        // Enrichment fields are emitted only for fully-detailed vendor responses: both the vendor
        // flag id and a condition index must be present (contracts eval-detailed-fields vs
        // eval-multivariate-string / eval-payload-attached).
        if (flag.metadataId() != null && flag.conditionIndex() != null) {
            b.metadata("fireweave.vendorFlagId", flag.metadataId());
            if (flag.reasonCode() != null) {
                b.metadata("fireweave.reasonCode", flag.reasonCode());
            }
        }
        if (flag.fromCache()) {
            b.metadata("fireweave.fromCache", true);
        }
        return b.build();
    }

    /** Returns true when the fault only degrades definitions freshness (serve stale). */
    private boolean applyFault() throws FireweaveException {
        switch (fault.mode()) {
            case DELAY:
                if (fault.delayMs() > requestTimeoutMs) {
                    throw new FireweaveException(ErrorKind.Timeout);
                }
                return false;
            case HTTP_STATUS:
                if ("definitions".equals(fault.applyTo())) {
                    return true; // definitions poll failed; evaluation serves last-good snapshot
                }
                throw httpStatusError(fault.status());
            case INVALID_JSON:
                throw new FireweaveException(ErrorKind.MalformedResponse);
            case NETWORK_ERROR:
            case OFFLINE:
                throw new FireweaveException(ErrorKind.Network);
            case QUOTA_LIMITED:
                if (fault.quotaLimited().contains("feature_flags")) {
                    throw FireweaveException.quotaLimited();
                }
                return false;
            default:
                return false;
        }
    }

    private static FireweaveException httpStatusError(int status) {
        if (status == 401) {
            return new FireweaveException(ErrorKind.Authentication);
        }
        if (status == 403) {
            return new FireweaveException(ErrorKind.Authorization);
        }
        if (status == 429) {
            return new FireweaveException(ErrorKind.RateLimited);
        }
        if (status >= 500) {
            return new FireweaveException(ErrorKind.BackendUnavailable);
        }
        return new FireweaveException(ErrorKind.Network);
    }

    private static void checkType(FlagType flagType, FlagType requested) throws FireweaveException {
        if (flagType == requested) {
            return;
        }
        // Integral flags may be read as floats (lossless widening); everything else is a mismatch,
        // including float→integer even for integral values like 2.0 (eval-numeric-coercion-int-float).
        if (flagType == FlagType.INTEGER && requested == FlagType.FLOAT) {
            return;
        }
        throw new FireweaveException(ErrorKind.TypeMismatch);
    }

    private static boolean matches(FlagDefinition flag, EvaluationContext ctx) {
        if (flag.matchTargetingKey() != null
                && !flag.matchTargetingKey().equals(ctx.targetingKey())) {
            return false;
        }
        for (Map.Entry<String, JsonValue> e : flag.matchAttribute().entrySet()) {
            if (!e.getValue().equals(ctx.attributes().get(e.getKey()))) {
                return false;
            }
        }
        for (Map.Entry<String, JsonValue> e : flag.matchPerson().entrySet()) {
            if (!e.getValue().equals(ctx.attributes().get(e.getKey()))) {
                return false;
            }
        }
        for (Map.Entry<String, String> e : flag.matchGroups().entrySet()) {
            String actual = ctx.groups().get(e.getKey());
            if (actual == null) {
                // Harness-normalized contexts may carry groups as a plain "groups" attribute.
                JsonValue groupsAttr = ctx.attributes().get("groups");
                if (groupsAttr != null && groupsAttr.kind() == JsonValue.Kind.OBJECT) {
                    JsonValue v = groupsAttr.asObject().get(e.getKey());
                    if (v != null && v.kind() == JsonValue.Kind.STRING) {
                        actual = v.asString();
                    }
                }
            }
            if (!e.getValue().equals(actual)) {
                return false;
            }
        }
        return true;
    }

    @Override
    public void deliverExposure(Exposure exposure) {
        deliveredExposures.add(exposure);
    }

    @Override
    public void deliverSignal(Signal signal) {
        deliveredSignals.add(signal);
    }

    @Override
    public Map<String, Boolean> runtimeFeatures() {
        return Collections.unmodifiableMap(runtimeFeatures);
    }

    @Override
    public void shutdown() {
        // Nothing to release; recorded events stay readable for assertions after shutdown.
    }

    public int evaluateCallCount() {
        return evaluateCalls.get();
    }

    /** Last merged context seen by evaluate(), for resolved-context assertions. */
    public EvaluationContext lastContext() {
        return lastContext.get();
    }

    public List<Exposure> deliveredExposures() {
        return Collections.unmodifiableList(deliveredExposures);
    }

    public List<Signal> deliveredSignals() {
        return Collections.unmodifiableList(deliveredSignals);
    }
}
