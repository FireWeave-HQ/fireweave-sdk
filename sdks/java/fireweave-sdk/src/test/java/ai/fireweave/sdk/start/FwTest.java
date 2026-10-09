package ai.fireweave.sdk.start;

import ai.fireweave.sdk.application.FireweaveClient;
import ai.fireweave.sdk.application.RegisterTargetResult;
import ai.fireweave.sdk.domain.Decision;
import ai.fireweave.sdk.domain.ErrorKind;
import ai.fireweave.sdk.domain.EvaluationContext;
import ai.fireweave.sdk.domain.FireweaveException;
import ai.fireweave.sdk.domain.JsonValue;
import ai.fireweave.sdk.domain.Mode;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The {@link Fw} facade over the process-wide singleton: local values, the missing-key warning,
 * idempotency and conflicts, the implicit start, reads that never throw, status, the instance key,
 * identify, shutdown and restart, and a real remote round trip.
 */
class FwTest {

    private static final String KEY = "project-api-key_fw-test-secret";
    private static final EvaluationContext CTX = EvaluationContext.builder().targetingKey("user-1").build();

    /** The stand-in process environment for implicit starts and instanceKey(). */
    private final Map<String, String> processEnv = new HashMap<>();
    private final List<String> lines = new CopyOnWriteArrayList<>();
    private HttpServer server;

    @BeforeEach
    void reset() {
        Fw.resetForTests(processEnv::get, () -> "api-pod-1");
    }

    @AfterEach
    void tearDown() {
        Fw.resetForTests(null, null);
        if (server != null) {
            server.stop(0);
        }
    }

    private StartOptions.Builder dev() {
        return StartOptions.builder().env(Map.of("FIREWEAVE_ENV", "development")).log(lines::add);
    }

    private static LocalControlPoints controlPoints(String key, boolean value) {
        return Fw.defineControlPoints(Map.of(key, LocalControlPoint.local(value)));
    }

    private long linesContaining(String text) {
        return lines.stream().filter(l -> l.contains(text)).count();
    }

    // ---------------------------------------------------------------- local mode

    @Test
    void localModeServesTheControlPointsAndWarnsOnceForAKeyMissingFromThem() {
        FireweaveClient returned = Fw.start(dev().controlPoints(controlPoints("new-checkout", true)).build());
        assertSame(Fw.client(), returned);

        assertTrue(Fw.controlPoints().getBooleanValue("new-checkout", false, CTX));
        Decision d = Fw.controlPoints().getBooleanDetails("new-checkout", false, CTX);
        assertEquals("STATIC", d.reason());

        assertFalse(Fw.controlPoints().getBooleanValue("not-declared", false, CTX));
        assertFalse(Fw.controlPoints().getBooleanValue("not-declared", false, CTX));
        assertEquals("DEFAULT", Fw.controlPoints().getBooleanDetails("not-declared", false, CTX).reason());
        assertEquals(1, linesContaining("\"not-declared\" is not in your control points (FireweaveControlPoints.java)"), lines.toString());
        assertEquals(1, linesContaining("[fireweave:local] Local mode (no FIREWEAVE_KEY; environment \"development\" "
                + "from FIREWEAVE_ENV). Serving 1 control point from your control points"), lines.toString());

        StartStatus s = Fw.status();
        assertEquals(StartState.READY, s.state());
        assertEquals(Mode.LOCAL, s.mode());
        assertEquals("environment", s.modeSource());
        assertEquals("development", s.environment());
        assertEquals("none", s.keySource());
        assertEquals(1, s.controlPointCount());
        assertNull(s.host());
    }

    @Test
    void theNineReadMethodsAreTheCoreOnesAndNeverThrowEvenWhenStartFailed() {
        FireweaveException e = assertThrows(FireweaveException.class,
                () -> Fw.start(StartOptions.builder().env(Map.of("FIREWEAVE_ENV", "production")).log(lines::add).build()));
        assertEquals(ErrorKind.Configuration, e.kind());

        FireweaveClient.ControlPoints cp = Fw.controlPoints();
        assertFalse(cp.getBooleanValue("k", false, CTX));
        assertEquals("fallback", cp.getStringValue("k", "fallback", CTX));
        assertEquals(1.5, cp.getNumberValue("k", 1.5, CTX));
        assertEquals(JsonValue.ofNull(), cp.getObjectValue("k", null, CTX));
        for (Decision d : List.of(cp.getBooleanDetails("k", false, CTX), cp.getStringDetails("k", "x", CTX),
                cp.getNumberDetails("k", 2, CTX), cp.getObjectDetails("k", JsonValue.ofObject(Map.of()), CTX))) {
            assertEquals("ERROR", d.reason());
            assertEquals(ErrorKind.Configuration, d.error().kind());
            assertTrue(d.error().message().contains("FIREWEAVE_KEY is not set"), d.error().message());
            assertEquals("Configuration", d.controlPointMetadata().get(ErrorKind.FLAG_METADATA_ERROR_KIND_KEY));
        }
        assertFalse(Fw.identify("user-1").ok());
        assertEquals(StartState.FAILED, Fw.status().state());
        assertTrue(Fw.status().error().contains("FIREWEAVE_KEY is not set"));
    }

    // ---------------------------------------------------------------- idempotency

    @Test
    void anIdenticalSecondStartIsANoOpAndADifferentOneThrowsNamingFieldsOnly() {
        Fw.start(dev().controlPoints(controlPoints("a", true)).build());
        Fw.start(dev().controlPoints(controlPoints("a", true)).build());

        FireweaveException e = assertThrows(FireweaveException.class, () -> Fw.start(dev().controlPoints(controlPoints("a", false)).build()));
        assertEquals(ErrorKind.Configuration, e.kind());
        assertTrue(e.getMessage().contains("Fw.start was already called with a different configuration (controlPoints)"),
                e.getMessage());
        assertTrue(Fw.controlPoints().getBooleanValue("a", false, CTX), "the running client is untouched");

        // A bad second start never takes the running client down either.
        assertThrows(FireweaveException.class, () -> Fw.start(StartOptions.builder().key("fw_public_x").build()));
        assertEquals(StartState.READY, Fw.status().state());
    }

    @Test
    void aConflictingKeyIsReportedWithoutEitherValue() {
        Fw.start(StartOptions.builder().key(KEY).env(Map.of()).build());
        String other = "project-api-key_another-secret";
        FireweaveException e = assertThrows(FireweaveException.class,
                () -> Fw.start(StartOptions.builder().key(other).env(Map.of()).build()));
        assertTrue(e.getMessage().contains("(key)"), e.getMessage());
        assertFalse(e.getMessage().contains(KEY) || e.getMessage().contains(other), e.getMessage());
    }

    @Test
    void flagsDoNotCountInRemoteMode() {
        Fw.start(StartOptions.builder().key(KEY).env(Map.of()).build());
        Fw.start(StartOptions.builder().key(KEY).env(Map.of()).controlPoints(controlPoints("a", true)).build());
        assertEquals(Mode.REMOTE, Fw.status().mode());
    }

    // ---------------------------------------------------------------- implicit start

    @Test
    void aReadBeforeStartStartsFromTheEnvironmentOnceOnThatRead() {
        processEnv.put("FIREWEAVE_ENV", "test");
        assertEquals(StartState.UNSTARTED, Fw.status().state());

        assertFalse(Fw.controlPoints().getBooleanValue("a", false, CTX));
        assertEquals(StartState.READY, Fw.status().state());
        assertEquals("environment", Fw.status().modeSource());
        assertEquals("test", Fw.status().environment());

        // The app's own start then differs (it adds controlPoints in local mode): that is an error.
        FireweaveException e = assertThrows(FireweaveException.class, () -> Fw.start(dev().controlPoints(controlPoints("a", true)).build()));
        assertTrue(e.getMessage().startsWith("A control point was read before Fw.start ran"), e.getMessage());

        // An identical start is still a no-op.
        Fw.start(StartOptions.builder().env(Map.of("FIREWEAVE_ENV", "test")).build());
    }

    @Test
    void aFailedImplicitStartServesDefaultsOnceAndAnExplicitStartStillWorks() {
        Decision d = Fw.controlPoints().getBooleanDetails("a", false, CTX);
        assertEquals("ERROR", d.reason());
        assertEquals(ErrorKind.Configuration, d.error().kind());
        assertEquals(StartState.FAILED, Fw.status().state());

        // Not retried on every read: the env is read once.
        processEnv.put("FIREWEAVE_ENV", "development");
        assertEquals("ERROR", Fw.controlPoints().getBooleanDetails("a", false, CTX).reason());

        Fw.start(dev().controlPoints(controlPoints("a", true)).build());
        assertTrue(Fw.controlPoints().getBooleanValue("a", false, CTX));
    }

    @Test
    void concurrentFirstReadsStartExactlyOnce() throws Exception {
        processEnv.put("FIREWEAVE_ENV", "dev");
        int threads = 16;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        CountDownLatch go = new CountDownLatch(1);
        List<Future<Boolean>> results = new ArrayList<>();
        for (int i = 0; i < threads; i++) {
            results.add(pool.submit(() -> {
                go.await();
                return Fw.controlPoints().getBooleanValue("a", true, CTX);
            }));
        }
        go.countDown();
        for (Future<Boolean> f : results) {
            assertTrue(f.get(10, TimeUnit.SECONDS), "every read returned its default without throwing");
        }
        pool.shutdown();
        assertEquals(StartState.READY, Fw.status().state());
    }

    // ---------------------------------------------------------------- status, instance key

    @Test
    void statusNeverContainsTheKey() {
        Fw.start(StartOptions.builder()
                .env(Map.of("FIREWEAVE_KEY", KEY, "FIREWEAVE_URL", "http://127.0.0.1:9/"))
                .build());
        StartStatus s = Fw.status();
        assertEquals(Mode.REMOTE, s.mode());
        assertEquals("key", s.modeSource());
        assertEquals("FIREWEAVE_KEY", s.keySource());
        assertEquals("127.0.0.1", s.host());
        assertEquals("FIREWEAVE_URL", s.endpointSource());
        assertEquals(Fw.sdkVersion(), s.sdkVersion());
        assertEquals(Fw.sdkChannel(), s.channel());
        assertFalse(s.toString().contains(KEY), s.toString());
        assertFalse(StartOptions.builder().key(KEY).build().toString().contains(KEY));
    }

    @Test
    void theDefaultEndpointIsTheChannelHost() {
        Fw.start(StartOptions.builder().key(KEY).env(Map.of()).build());
        StartStatus s = Fw.status();
        String expected = Fw.sdkChannel() == SdkChannel.STAGING
                ? "staging-app-server.fireweave.ai" : "app-server.fireweave.ai";
        assertEquals(expected, s.host());
        assertEquals("SDK channel (" + Fw.sdkChannel() + ")", s.endpointSource());
    }

    @Test
    void instanceKeyHashesTheHostNameAndIsCached() {
        assertEquals("inst_8148fc8bb0e952ef", Fw.instanceKey());
        assertSame(Fw.instanceKey(), Fw.instanceKey());

        // A key handed out before start pins it: a different instanceId is an error.
        FireweaveException e = assertThrows(FireweaveException.class,
                () -> Fw.start(dev().instanceId("cron-1").build()));
        assertTrue(e.getMessage().contains("instanceId differs"), e.getMessage());
    }

    @Test
    void instanceKeyPrefersTheOptionThenTheVariable() {
        Fw.start(dev().instanceId("cron-1").build());
        assertEquals("cron-1", Fw.instanceKey());

        Fw.resetForTests(Map.of("FIREWEAVE_INSTANCE_ID", "worker-7")::get, () -> "api-pod-1");
        assertEquals("worker-7", Fw.instanceKey());
    }

    // ---------------------------------------------------------------- identify

    @Test
    void identifyRegistersAUserAndNeverThrows() {
        Fw.start(dev().build());
        RegisterTargetResult ok = Fw.identify("user-1", Map.of("plan", "pro"));
        assertTrue(ok.ok(), String.valueOf(ok));
        assertEquals(1, linesContaining("[fireweave:local] registerTarget user user-1 {\"plan\":\"pro\"}"), lines.toString());

        RegisterTargetResult blank = Fw.identify("  ");
        assertFalse(blank.ok());
        assertEquals(ErrorKind.InvalidContext, blank.error().kind());

        RegisterTargetResult unsupported = Fw.identify("user-1", Map.of("at", new Object()));
        assertFalse(unsupported.ok());
        assertEquals(ErrorKind.InvalidContext, unsupported.error().kind());
        assertTrue(unsupported.error().message().contains("property \"at\" has an unsupported type (java.lang.Object)"),
                unsupported.error().message());

        Map<String, Object> cyclic = new HashMap<>();
        cyclic.put("self", cyclic);
        RegisterTargetResult cycle = Fw.identify("user-1", Collections.singletonMap("nested", cyclic));
        assertFalse(cycle.ok());
        assertTrue(cycle.error().message().contains("circular reference"), cycle.error().message());

        Map<String, Object> nullName = new HashMap<>();
        nullName.put(null, "x");
        assertFalse(Fw.identify("user-1", nullName).ok());
    }

    // ---------------------------------------------------------------- shutdown, restart

    @Test
    void shutdownServesDefaultsAndALaterStartBeginsFresh() {
        FireweaveClient before = Fw.client();
        Fw.start(dev().controlPoints(controlPoints("a", true)).build());
        assertTrue(Fw.controlPoints().getBooleanValue("a", false, CTX));

        Fw.shutdown();
        Fw.shutdown(); // idempotent
        assertEquals(StartState.SHUTDOWN, Fw.status().state());
        Decision closed = Fw.controlPoints().getBooleanDetails("a", false, CTX);
        assertEquals("ERROR", closed.reason());
        assertEquals(ErrorKind.AlreadyClosed, closed.error().kind());
        assertEquals(StartState.SHUTDOWN, Fw.status().state(), "nothing starts implicitly after shutdown");
        assertEquals(ErrorKind.AlreadyClosed, Fw.identify("user-1").error().kind());

        // A different configuration is fine after shutdown.
        Fw.start(dev().controlPoints(controlPoints("a", false)).build());
        assertFalse(Fw.controlPoints().getBooleanValue("a", true, CTX));
        assertEquals(StartState.READY, Fw.status().state());
        assertSame(before, Fw.client(), "one permanent client across start, shutdown and restart");
    }

    // ---------------------------------------------------------------- remote

    @Test
    void remoteModeDrivesRealRequestsWithTheKeyAndIgnoresLocalValues() throws Exception {
        List<String> auth = new CopyOnWriteArrayList<>();
        List<String> registerBodies = new CopyOnWriteArrayList<>();
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/control-points/evaluate", exchange -> {
            auth.add(exchange.getRequestHeaders().getFirst("Authorization"));
            exchange.getRequestBody().readAllBytes();
            byte[] resp = ("{\"decisions\":[{\"controlPointKey\":\"checkout-v2\",\"value\":true,"
                    + "\"reason\":\"TARGETING_MATCH\",\"found\":true,\"enabled\":true}]}")
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, resp.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(resp);
            }
        });
        server.createContext("/v1/targets/register", exchange -> {
            registerBodies.add(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            byte[] resp = "{\"ok\":true}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, resp.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(resp);
            }
        });
        server.setExecutor(Executors.newCachedThreadPool());
        server.start();

        Fw.start(StartOptions.builder()
                .env(Map.of("FIREWEAVE_KEY", KEY,
                        "FIREWEAVE_URL", "http://127.0.0.1:" + server.getAddress().getPort(),
                        "FIREWEAVE_ENV", "development"))
                .controlPoints(controlPoints("checkout-v2", false))
                .log(lines::add)
                .build());

        assertTrue(Fw.controlPoints().getBooleanValue("checkout-v2", false, CTX), "fw-server decides, not the controlPoints");
        assertEquals(List.of("Bearer " + KEY), auth);
        assertEquals(Mode.REMOTE, Fw.status().mode());

        RegisterTargetResult r = Fw.identify("user-1", Map.of("plan", "pro"));
        assertTrue(r.ok(), String.valueOf(r));
        assertEquals(1, registerBodies.size());
        assertTrue(registerBodies.get(0).contains("\"kind\":\"user\""), registerBodies.get(0));
        assertTrue(registerBodies.get(0).contains("\"plan\":\"pro\""), registerBodies.get(0));

        assertFalse(Fw.controlPoints().getBooleanValue("undeclared", false, CTX));
        assertEquals(0, linesContaining("is not in your control points"), "the missing-key warning is local-only");
        for (String line : lines) {
            assertFalse(line.contains(KEY), line);
        }
        assertNotNull(Fw.status().host());
    }
}
