package ai.fireweave.sdk.start;

import ai.fireweave.sdk.domain.ErrorKind;
import ai.fireweave.sdk.domain.EvaluationContext;
import ai.fireweave.sdk.domain.Redaction;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * SP-27: a refused key, rate limiting or an unreachable fw-server is logged once per kind for the
 * life of the process, naming the key's source or the host and never the key, and shows in
 * {@link StartStatus#lastErrorKind()}; and {@link Fw#verify()} reports it without throwing. Real
 * HTTP against a loopback {@link HttpServer} stub.
 */
class StartRemoteSignalTest {

    private static final String GOOD_KEY = "project-api-key_signal-good";
    private static final String WRONG_KEY = "project-api-key_signal-wrong";
    private static final EvaluationContext CTX = EvaluationContext.builder().targetingKey("user-1").build();

    private final List<String> lines = new CopyOnWriteArrayList<>();
    /** When non-zero, every request gets this status regardless of its key. */
    private final AtomicInteger forcedStatus = new AtomicInteger();
    private final AtomicInteger requests = new AtomicInteger();
    private HttpServer server;

    @BeforeEach
    void reset() throws IOException {
        Fw.resetForTests(new HashMap<String, String>()::get, () -> "api-pod-1");
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/flags/evaluate", exchange -> {
            requests.incrementAndGet();
            exchange.getRequestBody().readAllBytes();
            int status = status(exchange);
            reply(exchange, status, status == 200
                    ? "{\"decisions\":[{\"flagKey\":\"checkout-v2\",\"value\":true,\"found\":true}]}" : "{}");
        });
        server.createContext("/v1/targets/register", exchange -> {
            requests.incrementAndGet();
            exchange.getRequestBody().readAllBytes();
            int status = status(exchange);
            reply(exchange, status, status == 200 ? "{\"ok\":true}" : "{}");
        });
        server.setExecutor(Executors.newCachedThreadPool());
        server.start();
    }

    @AfterEach
    void tearDown() {
        Fw.resetForTests(null, null);
        server.stop(0);
    }

    private int status(HttpExchange exchange) {
        int forced = forcedStatus.get();
        if (forced != 0) {
            return forced;
        }
        return ("Bearer " + GOOD_KEY).equals(exchange.getRequestHeaders().getFirst("Authorization")) ? 200 : 401;
    }

    private static void reply(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }

    private String url() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    /** Starts from the environment, as a deploy does: the key comes from FIREWEAVE_KEY. */
    private void startWith(String key, String url) {
        Fw.start(StartOptions.builder()
                .env(Map.of("FIREWEAVE_KEY", key, "FIREWEAVE_URL", url))
                .log(lines::add)
                .build());
    }

    private long linesContaining(String text) {
        return lines.stream().filter(l -> l.contains(text)).count();
    }

    private void assertNoKeyIn(List<String> out) {
        for (String line : out) {
            assertFalse(line.contains(WRONG_KEY) || line.contains(GOOD_KEY), line);
            assertEquals(Redaction.sanitize(line), line, "a signal line survives redaction unchanged");
        }
    }

    @Test
    void aRejectedKeyIsLoggedOnceNamingFireweaveKeyAndShowsInStatus() {
        startWith(WRONG_KEY, url());
        assertNull(Fw.status().lastErrorKind(), "nothing has failed yet");

        for (int i = 0; i < 5; i++) {
            assertFalse(Fw.controlPoints().getBooleanValue("checkout-v2", false, CTX), "a refused key serves defaults");
        }
        assertFalse(Fw.identify("user-1").ok());
        assertEquals(ErrorKind.Authentication, Fw.controlPoints().getBooleanDetails("checkout-v2", false, CTX)
                .error().kind());

        assertEquals(1, linesContaining("rejected the key from FIREWEAVE_KEY (401, Authentication)"), lines.toString());
        assertEquals(1, linesContaining("(401, "), "repeated failures log once: " + lines);
        assertTrue(lines.get(0).contains("127.0.0.1"), lines.get(0));
        assertNoKeyIn(lines);
        assertEquals(ErrorKind.Authentication, Fw.status().lastErrorKind());
        assertTrue(Fw.status().toString().contains("lastErrorKind=Authentication"));
        assertFalse(Fw.status().toString().contains(WRONG_KEY));
        assertTrue(requests.get() >= 7, "every read really went to fw-server");
    }

    @Test
    void eachKindIsLoggedOnceForTheLifeOfTheProcessAndStatusKeepsTheLatest() {
        startWith(GOOD_KEY, url());
        assertTrue(Fw.controlPoints().getBooleanValue("checkout-v2", false, CTX));
        assertNull(Fw.status().lastErrorKind());

        forcedStatus.set(429);
        Fw.controlPoints().getBooleanValue("checkout-v2", false, CTX);
        Fw.controlPoints().getBooleanValue("checkout-v2", false, CTX);
        assertEquals(ErrorKind.RateLimited, Fw.status().lastErrorKind());

        forcedStatus.set(503);
        Fw.controlPoints().getBooleanValue("checkout-v2", false, CTX);
        assertEquals(ErrorKind.BackendUnavailable, Fw.status().lastErrorKind());

        forcedStatus.set(403);
        Fw.controlPoints().getBooleanValue("checkout-v2", false, CTX);
        assertEquals(ErrorKind.Authorization, Fw.status().lastErrorKind());

        // A restart in the same process does not log a kind again.
        Fw.shutdown();
        startWith(GOOD_KEY, url());
        assertNull(Fw.status().lastErrorKind(), "a new start begins with no remote failure");
        forcedStatus.set(429);
        Fw.controlPoints().getBooleanValue("checkout-v2", false, CTX);
        assertEquals(ErrorKind.RateLimited, Fw.status().lastErrorKind());

        assertEquals(1, linesContaining("(429, RateLimited)"), lines.toString());
        assertEquals(1, linesContaining("(BackendUnavailable)"), lines.toString());
        assertEquals(1, linesContaining("refused the key from FIREWEAVE_KEY (403, Authorization)"), lines.toString());
        assertEquals(3, lines.size(), lines.toString());
        assertNoKeyIn(lines);
    }

    @Test
    void anUnreachableEndpointNamesTheHostNeverTheKey() {
        String deadUrl = url();
        server.stop(0);
        startWith(GOOD_KEY, deadUrl);

        assertFalse(Fw.controlPoints().getBooleanValue("checkout-v2", false, CTX));
        assertFalse(Fw.controlPoints().getBooleanValue("checkout-v2", false, CTX));

        assertEquals(ErrorKind.Network, Fw.status().lastErrorKind());
        assertEquals(1, lines.size(), lines.toString());
        assertTrue(lines.get(0).contains("Could not reach fw-server at 127.0.0.1 (Network)"), lines.get(0));
        assertTrue(lines.get(0).contains("FIREWEAVE_URL"), lines.get(0));
        assertNoKeyIn(lines);

        VerifyResult v = Fw.verify();
        assertFalse(v.ok());
        assertEquals(ErrorKind.Network, v.errorKind());
    }

    @Test
    void verifyReportsAuthenticationForAWrongKeyWithoutThrowing() {
        startWith(WRONG_KEY, url());
        VerifyResult v = Fw.verify();
        assertFalse(v.ok(), v.toString());
        assertEquals(ErrorKind.Authentication, v.errorKind());
        assertFalse(v.toString().contains(WRONG_KEY), v.toString());
        assertEquals(1, requests.get(), "one round trip");
        // verify is a remote read like any other: it feeds the signal too.
        assertEquals(ErrorKind.Authentication, Fw.status().lastErrorKind());
        assertEquals(1, linesContaining("(401, "), lines.toString());
    }

    @Test
    void verifyIsOkForAGoodKeyEvenThoughTheProbeIsNotAControlPoint() {
        startWith(GOOD_KEY, url());
        VerifyResult v = Fw.verify();
        assertTrue(v.ok(), v.toString());
        assertNull(v.errorKind());
        assertEquals(1, requests.get(), "one round trip");
        assertNull(Fw.status().lastErrorKind());
        assertTrue(lines.isEmpty(), lines.toString());
    }

    @Test
    void verifyNeverThrowsInLocalModeAfterAFailedStartOrAfterShutdown() {
        Fw.start(StartOptions.builder().env(Map.of("FIREWEAVE_ENV", "development")).log(lines::add).build());
        VerifyResult local = Fw.verify();
        assertFalse(local.ok());
        assertEquals(ErrorKind.Configuration, local.errorKind());
        assertTrue(local.message().contains("local mode"), local.message());

        Fw.shutdown();
        assertEquals(ErrorKind.AlreadyClosed, Fw.verify().errorKind());

        Fw.resetForTests(Map.of("FIREWEAVE_ENV", "production")::get, () -> "api-pod-1");
        VerifyResult failed = Fw.verify();
        assertFalse(failed.ok());
        assertEquals(ErrorKind.Configuration, failed.errorKind());
        assertTrue(failed.message().contains("FIREWEAVE_KEY"), failed.message());
        assertEquals(0, requests.get(), "nothing reached fw-server");
    }
}
