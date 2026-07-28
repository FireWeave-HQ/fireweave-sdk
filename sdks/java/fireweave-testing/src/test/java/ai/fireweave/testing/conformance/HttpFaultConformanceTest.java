package ai.fireweave.testing.conformance;

import ai.fireweave.adapter.posthog.PostHogAdapter;
import ai.fireweave.sdk.Decision;
import ai.fireweave.sdk.EvaluationContext;
import ai.fireweave.sdk.FireweaveClient;
import ai.fireweave.sdk.FireweaveConfig;
import ai.fireweave.sdk.FireweaveRuntime;
import ai.fireweave.sdk.FlagType;
import ai.fireweave.testing.Json;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

/**
 * Re-runs the contracts/faults suite against the REAL HTTP protocol stub
 * (test-server/implementation/server.mjs, spawned as a child node process) through the
 * PostHogClientApi seam's HTTP client ({@link HttpStubPostHogClient}) + the real
 * {@link PostHogAdapter} + {@link FireweaveRuntime} — genuine sockets, timeouts, HTTP status
 * codes, truncated bodies and malformed JSON, per harness.md ("use test-server for faults that
 * require HTTP semantics").
 *
 * <p><b>Coverage split (documented limitation):</b> 8 of 9 fault fixtures are HTTP-drivable —
 * fault-timeout (stub delay vs request timeout), fault-auth-401, fault-rate-limit-429,
 * fault-backend-500, fault-malformed-json (invalid_json), fault-network-error (truncated
 * mid-body), fault-offline (connection refused on an unbound loopback port), and
 * fault-quota-limited-flags (HTTP 200 quota body). {@code fault-stale-cache} remains
 * adapter-simulated: it exercises local-eval definitions staleness (last-good definitions after
 * a failed poll), which lives behind the seam — the seam exposes snapshot {@code ageMs} but no
 * definitions-poll surface, and the vendor client that owns that lifecycle is unpublished
 * (ledger ruling 10).
 */
class HttpFaultConformanceTest {

    private static final ObjectMapper M = new ObjectMapper();
    private static final String TOKEN = "phc_TESTKEY0000000000000000000001";
    private static final HttpClient ADMIN = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(2)).build();

    private static Process server;
    private static String baseUrl;
    private static int unboundPort;
    private static Path contractsDir;

    @BeforeAll
    static void startStub() throws Exception {
        contractsDir = findContracts();
        Path serverMjs = contractsDir.getParent()
                .resolve("test-server").resolve("implementation").resolve("server.mjs");
        assertTrue(Files.exists(serverMjs), "test-server stub missing: " + serverMjs);

        int port = freePort();
        unboundPort = freePort(); // reserved-then-released: nothing listens here (offline case)
        try {
            server = new ProcessBuilder("node", serverMjs.toString(), "--port", String.valueOf(port))
                    .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                    .redirectErrorStream(false)
                    .redirectError(ProcessBuilder.Redirect.DISCARD)
                    .start();
        } catch (IOException e) {
            Assumptions.abort("node runtime unavailable; cannot start test-server stub: " + e);
        }
        baseUrl = "http://127.0.0.1:" + port;
        waitForHealth();
    }

    @AfterAll
    static void stopStub() {
        if (server != null) {
            server.destroy();
        }
    }

    @Test
    void faultSuitePassesOverRealHttpStub() throws Exception {
        List<Path> files;
        try (Stream<Path> s = Files.list(contractsDir.resolve("faults"))) {
            files = s.filter(p -> p.toString().endsWith(".json")).sorted().collect(Collectors.toList());
        }
        assertEquals(9, files.size(), "fault suite fixture count");

        List<String> failures = new ArrayList<>();
        List<String> passedOverHttp = new ArrayList<>();
        List<String> adapterSimulatedOnly = new ArrayList<>();
        for (Path file : files) {
            JsonNode fixture = M.readTree(file.toFile());
            String id = fixture.path("id").asText();
            if ("fault-stale-cache".equals(id)) {
                // Not HTTP-drivable through the seam (see class javadoc); stays covered by the
                // InMemoryAdapter simulation in ConformanceTest.
                adapterSimulatedOnly.add(id);
                continue;
            }
            List<String> problems = runOverHttp(fixture);
            if (problems.isEmpty()) {
                passedOverHttp.add(id);
            } else {
                failures.add(id + ": " + String.join("; ", problems));
            }
        }

        assertTrue(failures.isEmpty(), "fault fixtures failed over real HTTP:\n"
                + String.join("\n", failures));
        assertEquals(8, passedOverHttp.size(), "8 of 9 fault fixtures HTTP-drivable");
        assertEquals(List.of("fault-stale-cache"), adapterSimulatedOnly);
        System.out.println("faults-via-http-stub: " + passedOverHttp.size()
                + " pass over real HTTP " + passedOverHttp
                + "; adapter-simulated only: " + adapterSimulatedOnly
                + " (local-eval definitions staleness sits behind the seam)");
    }

    private List<String> runOverHttp(JsonNode fixture) throws Exception {
        JsonNode given = fixture.path("given");
        JsonNode when = fixture.path("when");
        JsonNode fault = given.path("fault");

        admin("/_test/reset", "{}");
        String target = baseUrl;
        switch (fault.path("mode").asText()) {
            case "httpStatus":
                admin("/_test/fault", "{\"mode\":\"" + fault.path("status").asInt() + "\"}");
                break;
            case "invalidJson":
                admin("/_test/fault", "{\"mode\":\"invalid_json\"}");
                break;
            case "networkError":
                admin("/_test/fault", "{\"mode\":\"truncated\"}");
                break;
            case "quotaLimited":
                admin("/_test/fault", "{\"mode\":\"quota_limited\"}");
                break;
            case "delay":
                admin("/_test/fault", "{\"mode\":\"delay\",\"delayMs\":"
                        + fault.path("delayMs").asInt(10000) + "}");
                break;
            case "offline":
                target = "http://127.0.0.1:" + unboundPort; // connection refused
                break;
            default:
                fail("unmapped fault mode: " + fault.path("mode").asText());
        }

        int timeoutMs = given.path("config").path("featureFlagsRequestTimeoutMs").asInt(3000);
        FireweaveConfig config = FireweaveConfig.builder()
                .projectApiKey(TOKEN)
                .host(target)
                .requestTimeoutMs(timeoutMs)
                .build();
        PostHogAdapter adapter = new PostHogAdapter(new HttpStubPostHogClient(target, TOKEN, timeoutMs));
        FireweaveRuntime runtime = new FireweaveRuntime(config, adapter);
        runtime.initialize();
        try {
            FireweaveClient client = new FireweaveClient(runtime);
            EvaluationContext ctx = EvaluationContext.builder()
                    .targetingKey(when.path("invocationContext").path("targetingKey").asText())
                    .build();
            Decision d = client.evaluate(
                    when.path("flagKey").asText(),
                    FlagType.fromCanonical(when.path("flagType").asText()),
                    Json.fromJackson(when.get("defaultValue")),
                    ctx, null);
            return FixtureComparator.compare(fixture.get("expect"), decisionToNode(d));
        } finally {
            runtime.shutdown();
        }
    }

    private static ObjectNode decisionToNode(Decision d) {
        ObjectNode actual = M.createObjectNode();
        actual.set("value", Json.toJackson(d.value()));
        if (d.variant() != null) {
            actual.put("variant", d.variant());
        } else {
            actual.putNull("variant");
        }
        actual.put("reason", d.reason());
        if (d.error() != null) {
            actual.put("errorCode", d.error().openFeatureErrorCode());
            actual.put("errorMessage", d.error().message());
        } else {
            actual.putNull("errorCode");
            actual.putNull("errorMessage");
        }
        if (!d.flagMetadata().isEmpty()) {
            ObjectNode metadata = actual.putObject("flagMetadata");
            for (Map.Entry<String, Object> e : d.flagMetadata().entrySet()) {
                Object v = e.getValue();
                if (v instanceof Boolean) {
                    metadata.put(e.getKey(), (Boolean) v);
                } else if (v instanceof Integer) {
                    metadata.put(e.getKey(), (Integer) v);
                } else if (v instanceof Long) {
                    metadata.put(e.getKey(), (Long) v);
                } else if (v instanceof Double) {
                    metadata.put(e.getKey(), (Double) v);
                } else if (v != null) {
                    metadata.put(e.getKey(), v.toString());
                }
            }
        }
        return actual;
    }

    private static void admin(String path, String body) throws Exception {
        HttpResponse<String> r = ADMIN.send(HttpRequest.newBuilder(URI.create(baseUrl + path))
                        .header("Content-Type", "application/json")
                        .timeout(Duration.ofSeconds(2))
                        .POST(HttpRequest.BodyPublishers.ofString(body))
                        .build(),
                HttpResponse.BodyHandlers.ofString());
        assertEquals(200, r.statusCode(), "stub admin call failed: " + path + " -> " + r.body());
    }

    private static void waitForHealth() throws Exception {
        HttpRequest health = HttpRequest.newBuilder(URI.create(baseUrl + "/health"))
                .timeout(Duration.ofSeconds(1)).GET().build();
        for (int i = 0; i < 100; i++) {
            try {
                if (ADMIN.send(health, HttpResponse.BodyHandlers.ofString()).statusCode() == 200) {
                    return;
                }
            } catch (IOException e) {
                // not up yet
            }
            Thread.sleep(50);
        }
        fail("test-server stub did not become healthy at " + baseUrl);
    }

    private static int freePort() throws IOException {
        try (ServerSocket s = new ServerSocket(0)) {
            s.setReuseAddress(true);
            return s.getLocalPort();
        }
    }

    private static Path findContracts() {
        Path p = Paths.get("").toAbsolutePath();
        while (p != null && !Files.exists(p.resolve("contracts").resolve("harness.md"))) {
            p = p.getParent();
        }
        assertNotNull(p, "contracts/ not found upward from CWD");
        return p.resolve("contracts");
    }
}
