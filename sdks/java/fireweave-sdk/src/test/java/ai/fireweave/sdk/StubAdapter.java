package ai.fireweave.sdk;

import ai.fireweave.sdk.application.BackendAdapter;
import ai.fireweave.sdk.application.EvaluationRequest;
import ai.fireweave.sdk.application.FireweaveConfig;
import ai.fireweave.sdk.domain.Decision;
import ai.fireweave.sdk.domain.FireweaveException;
import ai.fireweave.sdk.domain.JsonValue;
import ai.fireweave.sdk.domain.Reasons;

import java.util.function.Function;

/** Minimal configurable adapter for runtime/client unit tests. */
final class StubAdapter implements BackendAdapter {

    volatile Function<EvaluationRequest, Decision> onEvaluate = req ->
            Decision.builder(req.flagKey()).value(JsonValue.of(true))
                    .variant("on").reason(Reasons.TARGETING_MATCH).build();
    volatile FireweaveException initFailure;
    volatile FireweaveException evalFailure;
    volatile int shutdownCalls;
    volatile boolean shutdownBlocksForever;

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
    public void shutdown() {
        if (shutdownBlocksForever) {
            try {
                new java.util.concurrent.CountDownLatch(1).await(); // wedged vendor close
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
        shutdownCalls++;
    }
}
