package ai.fireweave.sdk;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class RegisterTargetTest {

    private HttpServer server;

    @AfterEach
    void stop() {
        if (server != null) {
            server.stop(0);
        }
    }

    private FireweaveRemoteAdapter readyAdapter(AtomicReference<String> lastAuth,
                                                AtomicReference<String> lastBody,
                                                AtomicInteger status,
                                                AtomicInteger calls) throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/targets/register", exchange -> {
            calls.incrementAndGet();
            lastAuth.set(exchange.getRequestHeaders().getFirst("Authorization"));
            lastBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            int code = status.get();
            byte[] resp = "{\"ok\":true,\"targetingKey\":\"user-1\"}".getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            if (code >= 400) {
                resp = "{\"ok\":false}".getBytes(StandardCharsets.UTF_8);
            }
            exchange.sendResponseHeaders(code, resp.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(resp);
            }
        });
        server.setExecutor(Executors.newCachedThreadPool());
        server.start();
        String baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
        FireweaveRemoteAdapter adapter = new FireweaveRemoteAdapter();
        adapter.initialize(FireweaveConfig.builder()
                .host(baseUrl)
                .projectApiKey("project-api-key_test")
                .build());
        return adapter;
    }

    @Test
    void postsTargetWithBearerAuth() throws Exception {
        AtomicReference<String> lastAuth = new AtomicReference<>();
        AtomicReference<String> lastBody = new AtomicReference<>();
        AtomicInteger status = new AtomicInteger(200);
        AtomicInteger calls = new AtomicInteger();
        FireweaveRemoteAdapter adapter = readyAdapter(lastAuth, lastBody, status, calls);

        RegisterTargetResult result = adapter.registerTarget("user-1",
                RegisterTargetOptions.builder()
                        .kind(TargetKind.USER)
                        .environment("production")
                        .property("plan", JsonValue.of("enterprise"))
                        .property("beta", JsonValue.of(true))
                        .build());

        assertTrue(result.ok());
        assertEquals(1, calls.get());
        assertEquals("Bearer project-api-key_test", lastAuth.get());
        String body = lastBody.get();
        assertTrue(body.contains("\"targetingKey\":\"user-1\""));
        assertTrue(body.contains("\"kind\":\"user\""));
        assertTrue(body.contains("\"environment\":\"production\""));
        assertTrue(body.contains("\"plan\":\"enterprise\""));
        adapter.shutdown();
    }

    @Test
    void omitsOptionalFields() throws Exception {
        AtomicReference<String> lastAuth = new AtomicReference<>();
        AtomicReference<String> lastBody = new AtomicReference<>();
        AtomicInteger status = new AtomicInteger(200);
        AtomicInteger calls = new AtomicInteger();
        FireweaveRemoteAdapter adapter = readyAdapter(lastAuth, lastBody, status, calls);

        adapter.registerTarget("device-9", RegisterTargetOptions.empty());
        assertEquals("{\"targetingKey\":\"device-9\"}", lastBody.get());
        adapter.shutdown();
    }

    @Test
    void neverThrowsOnTransportFailure() throws Exception {
        AtomicInteger status = new AtomicInteger(500);
        FireweaveRemoteAdapter adapter = readyAdapter(new AtomicReference<>(),
                new AtomicReference<>(), status, new AtomicInteger());
        RegisterTargetResult result = adapter.registerTarget("user-1", RegisterTargetOptions.empty());
        assertFalse(result.ok());
        assertEquals(ErrorKind.BackendUnavailable, result.error().kind());
        adapter.shutdown();
    }

    @Test
    void retriesRetryableFailureOnce() throws Exception {
        AtomicInteger status = new AtomicInteger(503);
        AtomicInteger calls = new AtomicInteger();
        FireweaveRemoteAdapter adapter = readyAdapter(new AtomicReference<>(),
                new AtomicReference<>(), status, calls);
        // Flip to 200 after the first call is observed via a custom handler...
        // The shared handler reads status at request time; switch after first increment.
        server.stop(0);
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        AtomicInteger attempts = new AtomicInteger();
        server.createContext("/v1/targets/register", exchange -> {
            int n = attempts.incrementAndGet();
            exchange.getRequestBody().readAllBytes();
            int code = n == 1 ? 503 : 200;
            byte[] resp = (code == 200 ? "{\"ok\":true}" : "{}").getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(code, resp.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(resp);
            }
        });
        server.setExecutor(Executors.newCachedThreadPool());
        server.start();
        adapter = new FireweaveRemoteAdapter();
        adapter.initialize(FireweaveConfig.builder()
                .host("http://127.0.0.1:" + server.getAddress().getPort())
                .projectApiKey("project-api-key_test")
                .build());
        RegisterTargetResult result = adapter.registerTarget("user-1", RegisterTargetOptions.empty());
        assertTrue(result.ok());
        assertEquals(2, attempts.get());
        adapter.shutdown();
    }

    @Test
    void doesNotRetryAuthFailure() throws Exception {
        AtomicInteger status = new AtomicInteger(401);
        AtomicInteger calls = new AtomicInteger();
        FireweaveRemoteAdapter adapter = readyAdapter(new AtomicReference<>(),
                new AtomicReference<>(), status, calls);
        RegisterTargetResult result = adapter.registerTarget("user-1", RegisterTargetOptions.empty());
        assertFalse(result.ok());
        assertEquals(ErrorKind.Authentication, result.error().kind());
        assertEquals(1, calls.get());
        adapter.shutdown();
    }

    @Test
    void notReadyBeforeInitialize() {
        FireweaveRemoteAdapter adapter = new FireweaveRemoteAdapter();
        RegisterTargetResult result = adapter.registerTarget("user-1", RegisterTargetOptions.empty());
        assertFalse(result.ok());
        assertEquals(ErrorKind.NotReady, result.error().kind());
    }

    @Test
    void rejectsEmptyTargetingKey() throws Exception {
        FireweaveRemoteAdapter adapter = readyAdapter(new AtomicReference<>(),
                new AtomicReference<>(), new AtomicInteger(200), new AtomicInteger());
        RegisterTargetResult result = adapter.registerTarget("", RegisterTargetOptions.empty());
        assertFalse(result.ok());
        assertEquals(ErrorKind.InvalidContext, result.error().kind());
        assertEquals("TARGETING_KEY_MISSING", result.error().openFeatureErrorCode());
        adapter.shutdown();
    }

    @Test
    void runtimeDelegatesToAdapter() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        FireweaveRemoteAdapter adapter = readyAdapter(new AtomicReference<>(),
                new AtomicReference<>(), new AtomicInteger(200), calls);
        FireweaveRuntime runtime = new FireweaveRuntime(FireweaveConfig.builder()
                .host("http://127.0.0.1:" + server.getAddress().getPort())
                .projectApiKey("project-api-key_test")
                .build(), adapter);
        runtime.initialize();
        RegisterTargetResult result = runtime.registerTarget("user-1",
                RegisterTargetOptions.builder().property("plan", JsonValue.of("pro")).build());
        assertTrue(result.ok());
        assertEquals(1, calls.get());
        runtime.shutdown();
    }

    @Test
    void clientRegisterTargetMatchesRuntime() throws Exception {
        FireweaveRemoteAdapter adapter = readyAdapter(new AtomicReference<>(),
                new AtomicReference<>(), new AtomicInteger(200), new AtomicInteger());
        FireweaveRuntime runtime = new FireweaveRuntime(FireweaveConfig.builder()
                .host("http://127.0.0.1:" + server.getAddress().getPort())
                .projectApiKey("project-api-key_test")
                .build(), adapter);
        runtime.initialize();
        FireweaveClient client = new FireweaveClient(runtime);
        assertTrue(client.registerTarget("user-1").ok());
        runtime.shutdown();
    }

    @Test
    void unsupportedOnLocalAdapter() throws Exception {
        FireweaveRuntime runtime = new FireweaveRuntime(
                FireweaveConfig.builder().build(), new FireweaveLocalAdapter());
        runtime.initialize();
        RegisterTargetResult result = runtime.registerTarget("user-1", RegisterTargetOptions.empty());
        assertFalse(result.ok());
        assertEquals(ErrorKind.UnsupportedCapability, result.error().kind());
        runtime.shutdown();
    }

    @Test
    void closedRuntime() throws Exception {
        FireweaveRuntime runtime = new FireweaveRuntime(
                FireweaveConfig.builder().build(), new FireweaveLocalAdapter());
        runtime.initialize();
        runtime.shutdown();
        RegisterTargetResult result = runtime.registerTarget("user-1", RegisterTargetOptions.empty());
        assertFalse(result.ok());
        assertEquals(ErrorKind.AlreadyClosed, result.error().kind());
    }

    @Test
    void notReadyRuntime() {
        FireweaveRuntime runtime = new FireweaveRuntime(
                FireweaveConfig.builder().build(), new FireweaveLocalAdapter());
        RegisterTargetResult result = runtime.registerTarget("user-1", RegisterTargetOptions.empty());
        assertFalse(result.ok());
        assertEquals(ErrorKind.NotReady, result.error().kind());
        assertNotNull(result.error());
    }
}
