package ai.fireweave.sdk;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class FireweaveRemoteAdapterTest {

    private HttpServer server;
    private String baseUrl;
    private final AtomicReference<String> lastAuth = new AtomicReference<>();
    private final AtomicReference<String> lastBody = new AtomicReference<>();

    @BeforeEach
    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/flags/evaluate", exchange -> {
            lastAuth.set(exchange.getRequestHeaders().getFirst("Authorization"));
            lastBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            byte[] resp = ("{\"decisions\":[{\"flagKey\":\"checkout-v2\",\"value\":true,"
                    + "\"reason\":\"TARGETING_MATCH\",\"found\":true,\"enabled\":true}]}").getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, resp.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(resp);
            }
        });
        server.setExecutor(Executors.newCachedThreadPool());
        server.start();
        baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @AfterEach
    void stop() {
        server.stop(0);
    }

    @Test
    void evaluatesViaFireweaveWireProtocol() throws Exception {
        FireweaveRemoteAdapter adapter = new FireweaveRemoteAdapter();
        adapter.initialize(FireweaveConfig.builder()
                .host(baseUrl)
                .projectApiKey("project-api-key_test")
                .build());

        Decision d = adapter.evaluate(new EvaluationRequest(
                "checkout-v2",
                FlagType.BOOLEAN,
                JsonValue.of(false),
                EvaluationContext.builder().targetingKey("user-1").build(),
                EvaluationOptions.defaults()));

        assertEquals(true, d.value().asBoolean());
        assertEquals(Reasons.TARGETING_MATCH, d.reason());
        assertEquals("Bearer project-api-key_test", lastAuth.get());
        assertTrue(lastBody.get().contains("\"targetingKey\":\"user-1\""));
        adapter.shutdown();
    }

    @Test
    void evaluateSendsGroupProperties() throws Exception {
        FireweaveRemoteAdapter adapter = new FireweaveRemoteAdapter();
        adapter.initialize(FireweaveConfig.builder()
                .host(baseUrl)
                .projectApiKey("project-api-key_test")
                .build());
        EvaluationContext ctx = EvaluationContext.builder()
                .targetingKey("user-1")
                .group("company", "acme")
                .groupProperty("company", "plan", JsonValue.of("pro"))
                .build();
        adapter.evaluate(new EvaluationRequest(
                "checkout-v2", FlagType.BOOLEAN, JsonValue.of(false), ctx, EvaluationOptions.defaults()));
        String body = lastBody.get();
        assertTrue(body.contains("\"groups\""));
        assertTrue(body.contains("\"groupProperties\""));
        assertTrue(body.contains("\"plan\":\"pro\""));
        adapter.shutdown();
    }

    @Test
    void initializeRequiresCredentials() {
        FireweaveRemoteAdapter adapter = new FireweaveRemoteAdapter();
        assertThrows(FireweaveException.class, () ->
                adapter.initialize(FireweaveConfig.builder().build()));
    }
}
