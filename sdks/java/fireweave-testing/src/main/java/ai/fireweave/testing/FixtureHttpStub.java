package ai.fireweave.testing;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Minimal in-process HTTP stub speaking the Fireweave-native
 * {@code POST /v1/flags/evaluate} route (spec/remote-protocol.md), for the faults suite.
 *
 * <p>Pure JDK ({@code com.sun.net.httpserver}) — no external test-server process: the
 * canonical dockerized {@code maven:3.9-eclipse-temurin-21} image has no {@code node} binary
 * to spawn {@code test-server/implementation/server.mjs} with (unlike node/python's
 * conformance runners). Fault state lives in this same process, so no admin HTTP protocol
 * is needed — {@link #setFault} is a plain method call.
 */
public final class FixtureHttpStub implements AutoCloseable {

    /** Fault mode this stub's next /v1/flags/evaluate response should exercise. */
    public static final class Fault {
        public String mode = "none"; // httpStatus | invalidJson | delay | quotaLimited | none
        public int status = 500;
        public String body;
        public long delayMs;

        public static Fault none() {
            return new Fault();
        }
    }

    private final HttpServer server;
    private final ExecutorService executor;
    private volatile Fault fault = Fault.none();
    private volatile String successBody = "{\"decisions\":[]}";

    private FixtureHttpStub(HttpServer server, ExecutorService executor) {
        this.server = server;
        this.executor = executor;
    }

    public static FixtureHttpStub start() throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        ExecutorService executor = Executors.newCachedThreadPool();
        FixtureHttpStub stub = new FixtureHttpStub(server, executor);
        server.createContext("/v1/flags/evaluate", stub::handleEvaluate);
        server.createContext("/v1/capture", stub::handleCapture);
        server.setExecutor(executor);
        server.start();
        return stub;
    }

    public String url() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    public void setFault(Fault fault) {
        this.fault = fault == null ? Fault.none() : fault;
    }

    public void setSuccessBody(String body) {
        this.successBody = body;
    }

    private void handleCapture(HttpExchange exchange) throws IOException {
        drain(exchange);
        sendJson(exchange, 200, "{\"ok\":true,\"accepted\":0}");
    }

    private void handleEvaluate(HttpExchange exchange) throws IOException {
        drain(exchange);
        Fault f = fault;
        switch (f.mode) {
            case "httpStatus":
                sendJson(exchange, f.status, "{\"error\":\"fault\"}");
                return;
            case "invalidJson":
                sendJson(exchange, 200, f.body != null ? f.body : "{not-json");
                return;
            case "delay":
                try {
                    Thread.sleep(f.delayMs);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                sendJson(exchange, 200, successBody);
                return;
            case "quotaLimited":
                sendJson(exchange, 200, "{\"decisions\":[],\"quotaLimited\":true}");
                return;
            default:
                sendJson(exchange, 200, successBody);
        }
    }

    private static void drain(HttpExchange exchange) throws IOException {
        byte[] buf = new byte[4096];
        while (exchange.getRequestBody().read(buf) != -1) {
            // discard
        }
    }

    private static void sendJson(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }

    @Override
    public void close() {
        server.stop(0);
        executor.shutdownNow();
    }
}
