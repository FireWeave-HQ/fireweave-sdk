package ai.fireweave.sdk.infrastructure.adapters;

import ai.fireweave.sdk.application.BackendAdapter;
import ai.fireweave.sdk.application.EvaluationRequest;
import ai.fireweave.sdk.application.FireweaveConfig;
import ai.fireweave.sdk.application.RegisterTargetOptions;
import ai.fireweave.sdk.application.RegisterTargetResult;
import ai.fireweave.sdk.domain.Decision;
import ai.fireweave.sdk.domain.ErrorKind;
import ai.fireweave.sdk.domain.FireweaveException;
import ai.fireweave.sdk.domain.FlagType;
import ai.fireweave.sdk.domain.JsonValue;
import ai.fireweave.sdk.domain.Reasons;
import ai.fireweave.sdk.domain.TargetKind;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;

/**
 * Local development adapter — the DEV substrate for a scaffolded harness.
 *
 * <p>Counterpart to {@link FireweaveRemoteAdapter}: production evaluates control
 * points against fw-server; development evaluates them here, in-process, with
 * no network and no credentials. Because it implements the same
 * {@link BackendAdapter} port, the dev branch of a harness runs through the
 * same {@code FireweaveRuntime} as production and inherits identical lifecycle
 * gating and context canonicalization.
 *
 * <p>Resolution policy:
 * <ul>
 *   <li>a key present in {@code devFlags} resolves to its mapped boolean with
 *       reason {@link Reasons#STATIC} and variant {@code on}/{@code off};</li>
 *   <li>every other key MISSES: the caller's default is returned with reason
 *       {@link Reasons#DEFAULT} — not an error (spec/modes.md "Behaviour per mode": local's
 *       unknown-key row is deliberately {@code default}/{@code DEFAULT}, unlike remote's
 *       {@code default}/{@code ERROR}/{@code FlagNotFound}). This adapter never THROWS on a
 *       miss — throwing here would be indistinguishable, from the runtime's perspective, from a
 *       genuine backend failure, and would produce the wrong (ERROR) reason; returning a plain
 *       {@link Decision} directly is the strict, typed seam that rules the ambiguity out.</li>
 * </ul>
 *
 * <p>{@link #name()} is {@code other} — {@code inmemory} belongs to a fixture adapter.
 */
public final class FireweaveLocalAdapter implements BackendAdapter {

    private final Map<String, Boolean> devFlags;
    private final Consumer<String> log;
    private final Map<String, LocalRegisteredTarget> targets = new ConcurrentHashMap<>();
    private volatile boolean closed;

    public FireweaveLocalAdapter() {
        this(Collections.emptyMap(), null);
    }

    public FireweaveLocalAdapter(Map<String, Boolean> devFlags) {
        this(devFlags, null);
    }

    /**
     * @param log sink for the {@code [fireweave:local]} registerTarget trace line
     *     (spec/modes.md "registerTarget in local mode"). Defaults to {@code System.out::println}
     *     when null. Injectable so tests can assert the call without capturing stdout, and so a
     *     host that owns its logging can route it.
     */
    public FireweaveLocalAdapter(Map<String, Boolean> devFlags, Consumer<String> log) {
        this.devFlags = Collections.unmodifiableMap(new LinkedHashMap<>(
                devFlags == null ? Collections.emptyMap() : devFlags));
        this.log = log != null ? log : System.out::println;
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
            return Decision.builder(request.flagKey())
                    .value(request.defaultValue())
                    .reason(Reasons.DEFAULT)
                    .build();
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

    /**
     * Records the target in-process and traces it, rather than reporting
     * {@code UnsupportedCapability} (spec/modes.md "registerTarget in local mode").
     *
     * <p>The failure being guarded against is a developer believing their targeting works
     * because nothing objected. A recorded target plus an explicit {@code [fireweave:local]}
     * line preserves that guarantee: nothing is silent, and local dev can exercise targeting
     * rules offline instead of only in production. The trace names the mode, so a line appearing
     * in a production log is itself the signal that something booted in local mode by mistake.
     *
     * <p>No network call is made and nothing reaches fw-server. Always resolves {@code ok=true}.
     */
    @Override
    public RegisterTargetResult registerTarget(String targetingKey, RegisterTargetOptions options) {
        RegisterTargetOptions opts = options == null ? RegisterTargetOptions.empty() : options;
        TargetKind kind = opts.kind() != null ? opts.kind() : TargetKind.USER;
        LocalRegisteredTarget target = new LocalRegisteredTarget(
                targetingKey, kind, opts.properties(), opts.environment());
        targets.put(targetingKey, target);
        log.accept("[fireweave:local] registerTarget " + kind.wireName() + " " + targetingKey + " "
                + JsonValue.ofObject(opts.properties()).toCanonicalJson()
                + " — recorded in-process, NOT sent to fw-server");
        return RegisterTargetResult.success();
    }

    /** Targets recorded this process, for assertions and dev inspection. */
    public List<LocalRegisteredTarget> getRegisteredTargets() {
        return new ArrayList<>(targets.values());
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
