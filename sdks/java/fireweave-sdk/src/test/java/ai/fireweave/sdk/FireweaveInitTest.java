package ai.fireweave.sdk;

import ai.fireweave.sdk.application.Fireweave;
import ai.fireweave.sdk.application.FireweaveClient;
import ai.fireweave.sdk.application.InitOptions;
import ai.fireweave.sdk.domain.Decision;
import ai.fireweave.sdk.domain.ErrorKind;
import ai.fireweave.sdk.domain.EvaluationContext;
import ai.fireweave.sdk.domain.FireweaveException;
import ai.fireweave.sdk.domain.Mode;
import ai.fireweave.sdk.infrastructure.adapters.FireweaveLocalAdapter;
import ai.fireweave.sdk.infrastructure.adapters.FireweaveRemoteAdapter;
import ai.fireweave.sdk.infrastructure.adapters.LocalRegisteredTarget;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@code Fireweave.init} — the single entry point (spec/modes.md).
 *
 * <p>Covers every row of the initialisation-validation table, both modes' adapter selection, and
 * the "does nothing else conditional on mode" property: {@code Fireweave.init} and {@link
 * FireweaveClient}/{@code ControlPoints} themselves never branch on mode past adapter selection
 * — any behavioural difference between modes lives entirely in the adapter seam (spec/modes.md
 * "Behaviour per mode"), never in a mode check downstream of it. That table has one deliberately
 * DIVERGENT row — an unknown control point resolves default/DEFAULT in local mode but
 * default/ERROR/FlagNotFound in remote — asserted per-mode below, not as a shared shape.
 * {@code registerTarget} genuinely IS shape-identical across modes (resolves ok:true, never
 * throws), which is also asserted below. The registerTarget wiring itself (recording + the
 * {@code [fireweave:local]} trace) is NOT re-implemented here — it is
 * {@code FireweaveLocalAdapter.registerTarget}, covered by FireweaveLocalAdapterTest; these tests
 * only assert it is reachable through the entry point.
 */
final class FireweaveInitTest {

    private HttpServer server;

    @AfterEach
    void stop() {
        if (server != null) {
            server.stop(0);
        }
    }

    // ------------------------------------------------------------------ initialisation-validation table

    @Test
    void modeAbsentIsConfiguration() {
        FireweaveException e = assertThrows(FireweaveException.class,
                () -> Fireweave.init(InitOptions.builder(null).build()));
        assertEquals(ErrorKind.Configuration, e.kind());
    }

    @Test
    void nullOptionsIsConfigurationNotACrash() {
        FireweaveException e = assertThrows(FireweaveException.class, () -> Fireweave.init(null));
        assertEquals(ErrorKind.Configuration, e.kind());
    }

    @Test
    void remoteModeWithApiKeyMissingIsConfiguration() {
        FireweaveException e = assertThrows(FireweaveException.class,
                () -> Fireweave.init(InitOptions.builder(Mode.REMOTE)
                        .apiUrl("https://app-server.fireweave.ai").build()));
        assertEquals(ErrorKind.Configuration, e.kind());
    }

    @Test
    void remoteModeWithApiUrlMissingIsConfiguration() {
        FireweaveException e = assertThrows(FireweaveException.class,
                () -> Fireweave.init(InitOptions.builder(Mode.REMOTE)
                        .apiKey("project-api-key_test").build()));
        assertEquals(ErrorKind.Configuration, e.kind());
    }

    @Test
    void remoteModeWithBlankApiKeyOrApiUrlIsConfiguration() {
        assertThrows(FireweaveException.class, () -> Fireweave.init(InitOptions.builder(Mode.REMOTE)
                .apiKey("   ").apiUrl("https://app-server.fireweave.ai").build()));
        assertThrows(FireweaveException.class, () -> Fireweave.init(InitOptions.builder(Mode.REMOTE)
                .apiKey("project-api-key_test").apiUrl("   ").build()));
    }

    @Test
    void apiUrlFailingTheHostAllowlistIsConfiguration() {
        FireweaveException e = assertThrows(FireweaveException.class,
                () -> Fireweave.init(InitOptions.builder(Mode.REMOTE)
                        .apiKey("project-api-key_test").apiUrl("https://evil.example.com").build()));
        assertEquals(ErrorKind.Configuration, e.kind());
    }

    @Test
    void localModeWithCredentialsSuppliedIsConfiguration() {
        assertThrows(FireweaveException.class, () -> Fireweave.init(InitOptions.builder(Mode.LOCAL)
                .apiKey("project-api-key_test").build()));
        assertThrows(FireweaveException.class, () -> Fireweave.init(InitOptions.builder(Mode.LOCAL)
                .apiUrl("https://app-server.fireweave.ai").build()));
        assertThrows(FireweaveException.class, () -> Fireweave.init(InitOptions.builder(Mode.LOCAL)
                .apiKey("project-api-key_test")
                .apiUrl("https://app-server.fireweave.ai")
                .controlPoints(Map.of())
                .build()));
    }

    @Test
    void localModeWithBlankApiKeyApiUrlIsNotTreatedAsSupplied() {
        FireweaveClient client = Fireweave.init(InitOptions.builder(Mode.LOCAL)
                .apiKey("").apiUrl("   ").controlPoints(Map.of())
                .build());
        client.close();
    }

    // ------------------------------------------------------------------ adapter selection

    @Test
    void localModeSelectsLocalAdapterSeedsTheMapAndReachesReady() {
        FireweaveClient client = Fireweave.init(InitOptions.local(Map.of("checkout-v2", true)));

        assertTrue(client.runtime().adapter() instanceof FireweaveLocalAdapter);
        assertEquals(ai.fireweave.sdk.domain.LifecycleState.READY, client.runtime().state());

        EvaluationContext ctx = EvaluationContext.empty();
        boolean on = client.controlPoints().getBooleanValue("checkout-v2", false, ctx);
        assertTrue(on);
        Decision details = client.controlPoints().getBooleanDetails("checkout-v2", false, ctx);
        assertEquals("STATIC", details.reason());

        client.close();
    }

    @Test
    void localModeAllowsEmptyOrOmittedControlPointsMap() {
        FireweaveClient empty = Fireweave.init(InitOptions.local(Map.of()));
        assertEquals(ai.fireweave.sdk.domain.LifecycleState.READY, empty.runtime().state());
        empty.close();

        FireweaveClient omitted = Fireweave.init(InitOptions.local());
        assertEquals(ai.fireweave.sdk.domain.LifecycleState.READY, omitted.runtime().state());
        omitted.close();
    }

    @Test
    void remoteModeSelectsRemoteAdapterAndEvaluatesOverEvaluatePath() throws Exception {
        List<String> lastAuth = new ArrayList<>();
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/flags/evaluate", exchange -> {
            lastAuth.add(exchange.getRequestHeaders().getFirst("Authorization"));
            byte[] resp = ("{\"decisions\":[{\"flagKey\":\"checkout-v2\",\"value\":true,"
                    + "\"reason\":\"TARGETING_MATCH\",\"found\":true,\"enabled\":true}]}")
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, resp.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(resp);
            }
        });
        server.setExecutor(Executors.newCachedThreadPool());
        server.start();
        String baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();

        FireweaveClient client = Fireweave.init(InitOptions.remote("project-api-key_test", baseUrl));
        assertTrue(client.runtime().adapter() instanceof FireweaveRemoteAdapter);
        assertEquals(ai.fireweave.sdk.domain.LifecycleState.READY, client.runtime().state());

        boolean on = client.controlPoints().getBooleanValue("checkout-v2", false,
                EvaluationContext.builder().targetingKey("user-1").build());
        assertTrue(on);
        assertEquals(1, lastAuth.size());
        assertEquals("Bearer project-api-key_test", lastAuth.get(0));

        client.close();
    }

    @Test
    void remoteModeExplicitAllowedHostsOverridePermitsASelfHostedApiUrl() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/flags/evaluate", exchange -> {
            byte[] resp = "{\"decisions\":[]}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, resp.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(resp);
            }
        });
        server.setExecutor(Executors.newCachedThreadPool());
        server.start();
        // Loopback already passes the default allowlist; the point of this test is that an
        // explicit allowedHosts override is honored end-to-end through Fireweave.init, not that
        // loopback specifically requires one.
        FireweaveClient client = Fireweave.init(InitOptions.builder(Mode.REMOTE)
                .apiKey("project-api-key_test")
                .apiUrl("http://127.0.0.1:" + server.getAddress().getPort())
                .allowedHosts(java.util.Set.of("127.0.0.1"))
                .build());
        assertEquals(ai.fireweave.sdk.domain.LifecycleState.READY, client.runtime().state());
        client.close();
    }

    // ------------------------------------------------------------------ nothing else conditional on mode

    @Test
    void readsNeverThrowInEitherModeButTheUnknownKeyRowIsDeliberatelyDivergent() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/flags/evaluate", exchange -> {
            byte[] resp = "{\"decisions\":[]}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, resp.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(resp);
            }
        });
        server.setExecutor(Executors.newCachedThreadPool());
        server.start();

        FireweaveClient local = Fireweave.init(InitOptions.local());
        FireweaveClient remote = Fireweave.init(InitOptions.remote(
                "project-api-key_test", "http://127.0.0.1:" + server.getAddress().getPort()));

        Decision localDecision = local.controlPoints().getBooleanDetails("does-not-exist", false,
                EvaluationContext.builder().targetingKey("user-1").build());
        assertEquals(false, localDecision.value().asBoolean());
        assertEquals("DEFAULT", localDecision.reason());
        assertEquals(null, localDecision.error());

        Decision remoteDecision = remote.controlPoints().getBooleanDetails("does-not-exist", false,
                EvaluationContext.builder().targetingKey("user-1").build());
        assertEquals(false, remoteDecision.value().asBoolean());
        assertEquals("ERROR", remoteDecision.reason());
        assertEquals(ErrorKind.FlagNotFound, remoteDecision.error().kind());

        local.close();
        remote.close();
    }

    @Test
    void registerTargetResolvesRatherThanRaisingInBothModes() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/targets/register", exchange -> {
            byte[] resp = "{\"ok\":true}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, resp.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(resp);
            }
        });
        server.setExecutor(Executors.newCachedThreadPool());
        server.start();

        FireweaveClient local = Fireweave.init(InitOptions.local());
        FireweaveClient remote = Fireweave.init(InitOptions.remote(
                "project-api-key_test", "http://127.0.0.1:" + server.getAddress().getPort()));

        assertTrue(local.registerTarget("user-1").ok());
        assertTrue(remote.registerTarget("user-1").ok());

        local.close();
        remote.close();
    }

    // ------------------------------------------------------------------ local registerTarget wiring

    @Test
    void localRegisterTargetRecordsInProcessAndTracesViaTheInjectedLogSink() {
        List<String> lines = new ArrayList<>();
        FireweaveClient client = Fireweave.init(InitOptions.builder(Mode.LOCAL)
                .controlPoints(Map.of())
                .log(lines::add)
                .build());

        Map<String, ai.fireweave.sdk.domain.JsonValue> properties = new LinkedHashMap<>();
        properties.put("plan", ai.fireweave.sdk.domain.JsonValue.of("pro"));
        boolean ok = client.registerTarget("user-1",
                ai.fireweave.sdk.application.RegisterTargetOptions.builder()
                        .properties(properties).build()).ok();
        assertTrue(ok);

        FireweaveLocalAdapter adapter = (FireweaveLocalAdapter) client.runtime().adapter();
        List<LocalRegisteredTarget> recorded = adapter.getRegisteredTargets();
        assertEquals(1, recorded.size());
        assertEquals("user-1", recorded.get(0).targetingKey());
        assertEquals(ai.fireweave.sdk.domain.JsonValue.of("pro"), recorded.get(0).properties().get("plan"));

        assertEquals(1, lines.size());
        assertTrue(lines.get(0).contains("[fireweave:local]"));
        assertTrue(lines.get(0).contains("NOT sent to fw-server"));

        client.close();
    }
}
