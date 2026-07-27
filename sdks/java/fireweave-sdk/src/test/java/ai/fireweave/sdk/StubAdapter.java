package ai.fireweave.sdk;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Function;

/** Minimal configurable adapter for runtime/client unit tests. */
final class StubAdapter implements BackendAdapter {

    volatile Function<EvaluationRequest, Decision> onEvaluate = req ->
            Decision.builder(req.flagKey()).value(JsonValue.of(true))
                    .variant("on").reason(Reasons.TARGETING_MATCH).build();
    volatile FireweaveException initFailure;
    volatile FireweaveException evalFailure;
    final List<Exposure> exposures = new CopyOnWriteArrayList<>();
    final List<Signal> signals = new CopyOnWriteArrayList<>();
    volatile int shutdownCalls;

    @Override
    public String name() {
        return "inmemory";
    }

    @Override
    public void initialize(FireweaveConfig config) throws FireweaveException {
        if (initFailure != null) {
            throw initFailure;
        }
    }

    @Override
    public Decision evaluate(EvaluationRequest request) throws FireweaveException {
        if (evalFailure != null) {
            throw evalFailure;
        }
        return onEvaluate.apply(request);
    }

    @Override
    public void deliverExposure(Exposure exposure) {
        exposures.add(exposure);
    }

    @Override
    public void deliverSignal(Signal signal) {
        signals.add(signal);
    }

    @Override
    public void shutdown() {
        shutdownCalls++;
    }
}
