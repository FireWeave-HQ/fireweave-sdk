package ai.fireweave.openfeature;

import ai.fireweave.sdk.BackendAdapter;
import ai.fireweave.sdk.Decision;
import ai.fireweave.sdk.EvaluationRequest;
import ai.fireweave.sdk.FireweaveConfig;
import ai.fireweave.sdk.FireweaveException;
import ai.fireweave.sdk.FireweaveRuntime;
import ai.fireweave.sdk.JsonValue;
import ai.fireweave.sdk.Reasons;
import dev.openfeature.sdk.ErrorCode;
import dev.openfeature.sdk.ImmutableContext;
import dev.openfeature.sdk.MutableContext;
import dev.openfeature.sdk.ProviderEvaluation;
import dev.openfeature.sdk.Value;
import dev.openfeature.sdk.exceptions.FatalError;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

class FireweaveProviderTest {

    /** Adapter stub echoing configurable decisions. */
    static final class Stub implements BackendAdapter {
        Function<EvaluationRequest, Decision> onEvaluate;
        FireweaveException evalFailure;
        EvaluationRequest lastRequest;

        @Override
        public String name() {
            return "inmemory";
        }

        @Override
        public void initialize(FireweaveConfig config) {
        }

        @Override
        public Decision evaluate(EvaluationRequest request) throws FireweaveException {
            lastRequest = request;
            if (evalFailure != null) {
                throw evalFailure;
            }
            return onEvaluate.apply(request);
        }

        @Override
        public void shutdown() {
        }
    }

    private static FireweaveProvider readyProvider(Stub stub) {
        FireweaveRuntime rt = new FireweaveRuntime(FireweaveConfig.builder().build(), stub);
        FireweaveProvider p = new FireweaveProvider(rt);
        p.initialize(new ImmutableContext());
        return p;
    }

    @Test
    void metadataNameIsFireweave() {
        assertEquals("fireweave", readyProvider(stubReturning(JsonValue.of(true))).getMetadata().getName());
    }

    private static Stub stubReturning(JsonValue value) {
        Stub s = new Stub();
        s.onEvaluate = req -> Decision.builder(req.flagKey())
                .value(value).variant("v").reason(Reasons.TARGETING_MATCH)
                .metadata("fireweave.flagVersion", 7).build();
        return s;
    }

    @Test
    void allResolverTypes() {
        ProviderEvaluation<Boolean> b = readyProvider(stubReturning(JsonValue.of(true)))
                .getBooleanEvaluation("f", false, new ImmutableContext());
        assertEquals(true, b.getValue());
        assertEquals("TARGETING_MATCH", b.getReason());
        assertEquals("v", b.getVariant());
        assertEquals(7, b.getFlagMetadata().getInteger("fireweave.flagVersion"));

        assertEquals("dark", readyProvider(stubReturning(JsonValue.of("dark")))
                .getStringEvaluation("f", "light", new ImmutableContext()).getValue());
        assertEquals(50, readyProvider(stubReturning(JsonValue.of(50)))
                .getIntegerEvaluation("f", 0, new ImmutableContext()).getValue());
        assertEquals(0.5, readyProvider(stubReturning(JsonValue.of(0.5)))
                .getDoubleEvaluation("f", 0.0, new ImmutableContext()).getValue());

        Map<String, JsonValue> obj = new LinkedHashMap<>();
        obj.put("mode", JsonValue.of("safe"));
        ProviderEvaluation<Value> o = readyProvider(stubReturning(JsonValue.ofObject(obj)))
                .getObjectEvaluation("f", new Value("x"), new ImmutableContext());
        assertEquals("safe", o.getValue().asStructure().getValue("mode").asString());
    }

    @Test
    void longClampBeyondIntegerRangeIsTypeMismatchNotTruncation() {
        ProviderEvaluation<Integer> e = readyProvider(stubReturning(JsonValue.of(4294967296L)))
                .getIntegerEvaluation("f", 7, new ImmutableContext());
        assertEquals(7, e.getValue(), "default served, never a truncated int");
        assertEquals(ErrorCode.TYPE_MISMATCH, e.getErrorCode());
    }

    @Test
    void errorDecisionMapsCodeMessageAndMetadata() {
        Stub s = new Stub();
        s.evalFailure = new FireweaveException(ai.fireweave.sdk.ErrorKind.FlagNotFound);
        ProviderEvaluation<Boolean> e = readyProvider(s)
                .getBooleanEvaluation("missing", false, new ImmutableContext());
        assertEquals(false, e.getValue());
        assertEquals(ErrorCode.FLAG_NOT_FOUND, e.getErrorCode());
        assertEquals("flag not found", e.getErrorMessage());
        assertEquals("ERROR", e.getReason());
        assertEquals("FlagNotFound", e.getFlagMetadata().getString("fireweave.errorKind"));
        assertNull(e.getVariant());
    }

    @Test
    void targetingKeyMapsToContextIdentity() {
        Stub s = stubReturning(JsonValue.of(true));
        readyProvider(s).getBooleanEvaluation("f", false,
                new MutableContext("org_42"));
        assertEquals("org_42", s.lastRequest.context().targetingKey());
    }

    @Test
    void notReadyBeforeInitialize() {
        Stub s = stubReturning(JsonValue.of(true));
        FireweaveRuntime rt = new FireweaveRuntime(FireweaveConfig.builder().build(), s);
        FireweaveProvider p = new FireweaveProvider(rt); // not initialized
        ProviderEvaluation<Boolean> e = p.getBooleanEvaluation("f", false, new ImmutableContext());
        assertEquals(ErrorCode.PROVIDER_NOT_READY, e.getErrorCode());
        assertEquals(false, e.getValue());
    }

    @Test
    void configurationFailureRaisesFatalError() {
        FireweaveRuntime rt = new FireweaveRuntime(
                FireweaveConfig.builder().projectApiKey("").build(), new Stub());
        FireweaveProvider p = new FireweaveProvider(rt);
        assertThrows(FatalError.class, () -> p.initialize(new ImmutableContext()));
    }

    @Test
    void shutdownIsIdempotentAndClosesRuntime() {
        Stub s = stubReturning(JsonValue.of(true));
        FireweaveProvider p = readyProvider(s);
        p.shutdown();
        p.shutdown();
        ProviderEvaluation<Boolean> e = p.getBooleanEvaluation("f", false, new ImmutableContext());
        assertEquals(ErrorCode.PROVIDER_NOT_READY, e.getErrorCode());
        assertEquals("provider already closed", e.getErrorMessage());
    }
}
