package ai.fireweave.testing.conformance;

import ai.fireweave.adapter.posthog.PostHogClientApi;
import ai.fireweave.adapter.posthog.PostHogFlagsSnapshot;
import ai.fireweave.adapter.posthog.PostHogTransportException;
import ai.fireweave.sdk.JsonValue;
import ai.fireweave.testing.Json;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Test-only {@link PostHogClientApi} implementation over real HTTP (JDK {@link HttpClient}),
 * targeting the deterministic PostHog protocol stub at test-server/implementation/server.mjs.
 *
 * <p>This is the seam's HTTP client used by {@code HttpFaultConformanceTest} to drive the
 * contracts/faults suite with genuine transport semantics (real sockets, real timeouts, real
 * truncated bodies) instead of the in-process InMemoryAdapter simulation. It is deliberately
 * test-scoped: the production adapter binding stays blocked on the unpublished
 * com.posthog:posthog-server artifact (ledger ruling 10).
 */
final class HttpStubPostHogClient implements PostHogClientApi {

    private static final ObjectMapper M = new ObjectMapper();

    private final HttpClient http;
    private final URI flagsUri;
    private final URI batchUri;
    private final String token;
    private final Duration requestTimeout;

    HttpStubPostHogClient(String baseUrl, String token, int requestTimeoutMs) {
        this.token = token;
        this.requestTimeout = Duration.ofMillis(requestTimeoutMs);
        this.http = HttpClient.newBuilder()
                .connectTimeout(Duration.ofMillis(Math.max(requestTimeoutMs, 250)))
                .build();
        this.flagsUri = URI.create(baseUrl + "/flags/?v=2");
        this.batchUri = URI.create(baseUrl + "/batch/");
    }

    @Override
    public PostHogFlagsSnapshot evaluateFlags(String distinctId,
                                              Map<String, JsonValue> personProperties,
                                              Map<String, String> groups,
                                              Map<String, Map<String, JsonValue>> groupProperties)
            throws PostHogTransportException {
        ObjectNode body = M.createObjectNode();
        body.put("token", token);
        body.put("distinct_id", distinctId);
        if (personProperties != null && !personProperties.isEmpty()) {
            ObjectNode props = body.putObject("person_properties");
            personProperties.forEach((k, v) -> props.set(k, Json.toJackson(v)));
        }
        if (groups != null && !groups.isEmpty()) {
            ObjectNode g = body.putObject("groups");
            groups.forEach(g::put);
        }
        if (groupProperties != null && !groupProperties.isEmpty()) {
            ObjectNode gp = body.putObject("group_properties");
            groupProperties.forEach((type, props) -> {
                ObjectNode typed = gp.putObject(type);
                props.forEach((k, v) -> typed.set(k, Json.toJackson(v)));
            });
        }

        String responseBody = post(flagsUri, body.toString());
        JsonNode root;
        try {
            root = M.readTree(responseBody);
        } catch (IOException e) {
            throw PostHogTransportException.malformedBody();
        }
        if (root == null || !root.isObject()) {
            throw PostHogTransportException.malformedBody();
        }
        return toSnapshot(root);
    }

    @Override
    public void capture(String distinctId, String event, Map<String, JsonValue> properties)
            throws PostHogTransportException {
        ObjectNode body = M.createObjectNode();
        body.put("api_key", token);
        ObjectNode item = body.putArray("batch").addObject();
        item.put("event", event);
        item.put("distinct_id", distinctId);
        ObjectNode props = item.putObject("properties");
        if (properties != null) {
            properties.forEach((k, v) -> props.set(k, Json.toJackson(v)));
        }
        post(batchUri, body.toString());
    }

    /** POST JSON; maps transport failures onto the seam's taxonomy. */
    private String post(URI uri, String json) throws PostHogTransportException {
        HttpRequest request = HttpRequest.newBuilder(uri)
                .header("Content-Type", "application/json")
                .timeout(requestTimeout)
                .POST(HttpRequest.BodyPublishers.ofString(json))
                .build();
        HttpResponse<String> response;
        try {
            response = http.send(request, HttpResponse.BodyHandlers.ofString());
        } catch (HttpTimeoutException e) {
            throw PostHogTransportException.timeout();
        } catch (IOException e) {
            // Connection refused (offline), reset, or a truncated body mid-stream.
            throw PostHogTransportException.network(e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw PostHogTransportException.network(e);
        }
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw PostHogTransportException.http(response.statusCode());
        }
        return response.body();
    }

    private static PostHogFlagsSnapshot toSnapshot(JsonNode root) {
        Map<String, PostHogFlagsSnapshot.FlagResult> flags = new LinkedHashMap<>();
        JsonNode flagsNode = root.path("flags");
        Iterator<Map.Entry<String, JsonNode>> it = flagsNode.fields();
        while (it.hasNext()) {
            Map.Entry<String, JsonNode> e = it.next();
            JsonNode f = e.getValue();
            JsonNode reason = f.path("reason");
            JsonNode metadata = f.path("metadata");
            flags.put(e.getKey(), new PostHogFlagsSnapshot.FlagResult(
                    e.getKey(),
                    f.path("enabled").asBoolean(false),
                    f.hasNonNull("variant") ? f.get("variant").asText() : null,
                    null,
                    parsePayload(metadata.get("payload")),
                    reason.hasNonNull("code") ? reason.get("code").asText() : null,
                    reason.hasNonNull("condition_index") ? reason.get("condition_index").asInt() : null,
                    metadata.hasNonNull("id") ? metadata.get("id").numberValue() : null,
                    metadata.hasNonNull("version") ? metadata.get("version").numberValue() : null));
        }
        List<String> quotaLimited = new ArrayList<>();
        JsonNode quota = root.get("quotaLimited");
        if (quota != null && quota.isArray()) {
            quota.forEach(q -> quotaLimited.add(q.asText()));
        }
        return new PostHogFlagsSnapshot(flags, quotaLimited,
                root.path("errorsWhileComputingFlags").asBoolean(false), 0);
    }

    /** Vendor payloads travel as JSON strings; parse when possible, else keep the raw string. */
    private static JsonValue parsePayload(JsonNode payload) {
        if (payload == null || payload.isNull()) {
            return null;
        }
        if (payload.isTextual()) {
            try {
                return Json.fromJackson(M.readTree(payload.textValue()));
            } catch (IOException e) {
                return JsonValue.of(payload.textValue());
            }
        }
        return Json.fromJackson(payload);
    }

    @Override
    public void close() {
        // JDK HttpClient has no explicit close on Java 11; nothing to release.
    }
}
