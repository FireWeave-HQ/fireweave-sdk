package ai.fireweave.sdk;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Local development adapter — the DEV substrate for a scaffolded harness.
 *
 * <p>Counterpart to {@link FireweaveRemoteAdapter}: production evaluates control
 * points against fw-server; development evaluates them here, in-process, with
 * no network and no credentials. Because it implements the same
 * {@link BackendAdapter} port, the dev branch of a harness runs through the
 * same {@link FireweaveRuntime} as production and inherits identical lifecycle
 * gating and context canonicalization.
 *
 * <p>Resolution policy:
 * <ul>
 *   <li>a key present in {@code devFlags} resolves to its mapped boolean with
 *       reason {@link Reasons#STATIC} and variant {@code on}/{@code off};</li>
 *   <li>every other key throws {@link ErrorKind#FlagNotFound}, which the runtime
 *       turns into an ERROR decision. {@code FireweaveLocalProvider} rewrites
 *       that single outcome to a clean DEFAULT on the OpenFeature path.</li>
 * </ul>
 *
 * <p>{@link #name()} is {@code other} — {@code inmemory} belongs to the fixture
 * adapter used by conformance.
 */
public final class FireweaveLocalAdapter implements BackendAdapter {

    private final Map<String, Boolean> devFlags;
    private volatile boolean closed;

    public FireweaveLocalAdapter() {
        this(Collections.emptyMap());
    }

    public FireweaveLocalAdapter(Map<String, Boolean> devFlags) {
        this.devFlags = Collections.unmodifiableMap(new LinkedHashMap<>(
                devFlags == null ? Collections.emptyMap() : devFlags));
    }

    @Override
    public String name() {
        return "other";
    }

    @Override
    public void initialize(FireweaveConfig config) {
        closed = false;
    }

    /**
     * A {@code devFlags} hit reports the mapped boolean with reason STATIC.
     * Reporting a disabled/off control point as {@code DISABLED} would mean
     * "switched off upstream" — not what a local override expresses.
     *
     * <p>Values are always boolean, so reading an overridden key as a string or
     * number yields {@link ErrorKind#TypeMismatch} rather than silently
     * returning the default.
     */
    @Override
    public Decision evaluate(EvaluationRequest request) throws FireweaveException {
        if (closed) {
            throw new FireweaveException(ErrorKind.AlreadyClosed);
        }
        Boolean override = devFlags.get(request.flagKey());
        if (override == null) {
            throw new FireweaveException(ErrorKind.FlagNotFound);
        }
        if (request.type() != FlagType.BOOLEAN) {
            throw new FireweaveException(ErrorKind.TypeMismatch);
        }
        return Decision.builder(request.flagKey())
                .value(JsonValue.of(override.booleanValue()))
                .variant(override ? "on" : "off")
                .reason(Reasons.STATIC)
                .build();
    }

    @Override
    public Map<String, Boolean> runtimeFeatures() {
        Map<String, Boolean> m = new LinkedHashMap<>();
        m.put("remoteEvaluation", false);
        m.put("localEvaluation", true);
        m.put("localOnly", true);
        // No exposure sink exists locally; claiming otherwise would advertise
        // emission that silently goes nowhere.
        m.put("exposureEmission", false);
        m.put("sideEffectFreeReads", true);
        m.put("groupAnalytics", false);
        return Collections.unmodifiableMap(m);
    }

    @Override
    public void shutdown() {
        closed = true;
    }

    /** Configured overrides (immutable). */
    public Map<String, Boolean> devFlags() {
        return devFlags;
    }

    @Override
    public String toString() {
        return "FireweaveLocalAdapter{keys=" + devFlags.keySet() + "}";
    }

    @Override
    public boolean equals(Object o) {
        return o instanceof FireweaveLocalAdapter
                && devFlags.equals(((FireweaveLocalAdapter) o).devFlags);
    }

    @Override
    public int hashCode() {
        return Objects.hash(devFlags);
    }
}
