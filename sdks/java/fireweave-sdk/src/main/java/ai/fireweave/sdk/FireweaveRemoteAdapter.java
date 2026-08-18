package ai.fireweave.sdk;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Fireweave remote backend adapter (ADR-0005) — <b>default production path</b>.
 *
 * <p>Speaks {@code POST /v1/flags/evaluate}, {@code POST /v1/capture}, and
 * {@code POST /v1/targets/register} to fw-server with
 * {@code Authorization: Bearer <FW_PROJECT_API_KEY>}. No PostHog SDK or keys in the customer
 * process. Config: {@link FireweaveConfig#host()} = {@code FW_API_URL},
 * {@link FireweaveConfig#projectApiKey()} = {@code FW_PROJECT_API_KEY}.
 */
public final class FireweaveRemoteAdapter implements BackendAdapter {

    private static final String EVALUATE_PATH = "/v1/flags/evaluate";
    private static final String CAPTURE_PATH = "/v1/capture";
    private static final String REGISTER_TARGET_PATH = "/v1/targets/register";

    private final HttpClient httpClient;
    private volatile String apiUrl;
    private volatile String apiKey;
    private volatile int requestTimeoutMs = FireweaveConfig.DEFAULT_REQUEST_TIMEOUT_MS;
    private volatile boolean ready;
    private volatile boolean closed;
    private final List<Map<String, JsonValue>> pending = new CopyOnWriteArrayList<>();

    public FireweaveRemoteAdapter() {
        this(HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build());
    }

    /** Test injection. */
    public FireweaveRemoteAdapter(HttpClient httpClient) {
        this.httpClient = Objects.requireNonNull(httpClient, "httpClient");
    }

    @Override
    public String name() {
        return "fireweave";
    }

    @Override
    public void initialize(FireweaveConfig config) throws FireweaveException {
        if (closed) {
            throw new FireweaveException(ErrorKind.AlreadyClosed);
        }
        Objects.requireNonNull(config, "config");
        String url = config.host();
        String key = config.projectApiKey();
        if (url == null || url.trim().isEmpty() || key == null || key.trim().isEmpty()) {
            throw new FireweaveException(ErrorKind.Configuration, "invalid configuration");
        }
        url = url.replaceAll("/+$", "");
        URI uri;
        try {
            uri = URI.create(url);
        } catch (IllegalArgumentException e) {
            throw new FireweaveException(ErrorKind.Configuration, "invalid configuration", e);
        }
        String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
        if (host.startsWith("[") && host.endsWith("]")) {
            host = host.substring(1, host.length() - 1);
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        boolean loopback = "localhost".equals(host) || "127.0.0.1".equals(host) || "::1".equals(host);
        if (!"https".equals(scheme) && !("http".equals(scheme) && loopback)) {
            throw new FireweaveException(ErrorKind.Configuration, "invalid configuration");
        }
        // Egress pin: configured apiUrl hostname + loopback (Node remote adapter parity).
        // DEFAULT_ALLOWED_HOSTS includes Fireweave + PostHog + loopback. Treat that default
        // set as "use apiUrl host pin" so a custom FW_API_URL not yet on the list still
        // works when the caller did not override allowedHosts. A custom allowedHosts
        // without the apiUrl host (and without '*') is rejected.
        java.util.Set<String> allow = config.allowedHosts();
        boolean usingDefaultAllowlist = allow.equals(FireweaveConfig.DEFAULT_ALLOWED_HOSTS);
        boolean allowed = allow.contains(FireweaveConfig.ALLOW_ANY_HOST)
                || allow.contains(host)
                || loopback
                || usingDefaultAllowlist;
        if (!allowed) {
            throw new FireweaveException(ErrorKind.Configuration, "invalid configuration");
        }
        this.apiUrl = url;
        this.apiKey = key;
        this.requestTimeoutMs = config.requestTimeoutMs();
        this.ready = true;
    }

    @Override
    public Decision evaluate(EvaluationRequest request) throws FireweaveException {
        if (closed) {
            throw new FireweaveException(ErrorKind.AlreadyClosed);
        }
        if (!ready) {
            throw new FireweaveException(ErrorKind.NotReady);
        }
        EvaluationContext ctx = request.context();
        String targetingKey = ctx.targetingKey();
        if (targetingKey == null || targetingKey.isEmpty()) {
            throw FireweaveException.targetingKeyMissing();
        }

        Map<String, JsonValue> body = new LinkedHashMap<>();
        body.put("targetingKey", JsonValue.of(targetingKey));
        List<JsonValue> flagKeys = new ArrayList<>();
        flagKeys.add(JsonValue.of(request.flagKey()));
        body.put("flagKeys", JsonValue.ofArray(flagKeys));

        Map<String, JsonValue> attributes = new LinkedHashMap<>();
        for (Map.Entry<String, JsonValue> e : ctx.attributes().entrySet()) {
            String k = e.getKey();
            if ("groups".equals(k) || "groupProperties".equals(k)
                    || k.startsWith("$") || k.startsWith("fireweave.")) {
                continue;
            }
            attributes.put(k, e.getValue());
        }
        if (!attributes.isEmpty()) {
            body.put("attributes", JsonValue.ofObject(attributes));
        }
        if (!ctx.groups().isEmpty()) {
            Map<String, JsonValue> groups = new LinkedHashMap<>();
            for (Map.Entry<String, String> g : ctx.groups().entrySet()) {
                groups.put(g.getKey(), JsonValue.of(g.getValue()));
            }
            body.put("groups", JsonValue.ofObject(groups));
        }
        if (!ctx.groupProperties().isEmpty()) {
            Map<String, JsonValue> groupProperties = new LinkedHashMap<>();
            for (Map.Entry<String, Map<String, JsonValue>> g : ctx.groupProperties().entrySet()) {
                groupProperties.put(g.getKey(), JsonValue.ofObject(g.getValue()));
            }
            body.put("groupProperties", JsonValue.ofObject(groupProperties));
        }

        JsonValue response = postJson(EVALUATE_PATH, JsonValue.ofObject(body));
        if (response.kind() != JsonValue.Kind.OBJECT) {
            throw new FireweaveException(ErrorKind.MalformedResponse);
        }
        Map<String, JsonValue> root = response.asObject();
        boolean quotaLimited = false;
        JsonValue quotaNode = root.get("quotaLimited");
        if (quotaNode != null && quotaNode.kind() == JsonValue.Kind.BOOLEAN) {
            quotaLimited = quotaNode.asBoolean();
        }
        JsonValue decisionsNode = root.get("decisions");
        if (decisionsNode == null || decisionsNode.kind() != JsonValue.Kind.ARRAY) {
            throw quotaLimited ? FireweaveException.quotaLimited() : new FireweaveException(ErrorKind.FlagNotFound);
        }
        for (JsonValue item : decisionsNode.asArray()) {
            if (item.kind() != JsonValue.Kind.OBJECT) {
                continue;
            }
            Map<String, JsonValue> d = item.asObject();
            JsonValue keyNode = d.get("flagKey");
            if (keyNode == null || keyNode.kind() != JsonValue.Kind.STRING
                    || !request.flagKey().equals(keyNode.asString())) {
                continue;
            }
            JsonValue foundNode = d.get("found");
            if (foundNode != null && foundNode.kind() == JsonValue.Kind.BOOLEAN && !foundNode.asBoolean()) {
                throw quotaLimited ? FireweaveException.quotaLimited() : new FireweaveException(ErrorKind.FlagNotFound);
            }
            JsonValue value = d.get("value");
            if (value == null) {
                value = request.defaultValue();
            }
            String reason = Reasons.TARGETING_MATCH;
            JsonValue reasonNode = d.get("reason");
            if (reasonNode != null && reasonNode.kind() == JsonValue.Kind.STRING) {
                reason = reasonNode.asString();
            }
            Decision.Builder b = Decision.builder(request.flagKey()).value(value).reason(reason);
            JsonValue variant = d.get("variant");
            if (variant != null && variant.kind() == JsonValue.Kind.STRING) {
                b.variant(variant.asString());
            }
            JsonValue payload = d.get("payload");
            if (payload != null) {
                b.payload(payload);
            }
            JsonValue meta = d.get("flagMetadata");
            if (meta != null && meta.kind() == JsonValue.Kind.OBJECT) {
                for (Map.Entry<String, JsonValue> m : meta.asObject().entrySet()) {
                    Object scalar = toScalar(m.getValue());
                    if (scalar != null) {
                        b.metadata(m.getKey(), scalar);
                    }
                }
            }
            if (quotaLimited) {
                b.metadata("fireweave.quotaLimited", true);
            }
            return b.build();
        }
        throw quotaLimited ? FireweaveException.quotaLimited() : new FireweaveException(ErrorKind.FlagNotFound);
    }

    /**
     * Register a user or device so flag rules can target its durable properties.
     *
     * <p>Never throws for transport failures: registration sits in login paths, and
     * an analytics call must not break sign-in. Retried once when the error
     * taxonomy marks the failure retryable.
     */
    @Override
    public RegisterTargetResult registerTarget(String targetingKey, RegisterTargetOptions options) {
        if (closed) {
            return RegisterTargetResult.failure(FireweaveError.of(ErrorKind.AlreadyClosed,
                    ErrorKind.AlreadyClosed.defaultMessage()));
        }
        if (!ready) {
            return RegisterTargetResult.failure(FireweaveError.of(ErrorKind.NotReady,
                    ErrorKind.NotReady.defaultMessage()));
        }
        if (targetingKey == null || targetingKey.isEmpty()) {
            return RegisterTargetResult.failure(FireweaveError.from(FireweaveException.targetingKeyMissing()));
        }

        RegisterTargetOptions opts = options == null ? RegisterTargetOptions.empty() : options;
        Map<String, JsonValue> body = new LinkedHashMap<>();
        body.put("targetingKey", JsonValue.of(targetingKey));
        if (opts.kind() != null) {
            body.put("kind", JsonValue.of(opts.kind().wireName()));
        }
        if (opts.environment() != null) {
            body.put("environment", JsonValue.of(opts.environment()));
        }
        if (!opts.properties().isEmpty()) {
            body.put("properties", JsonValue.ofObject(opts.properties()));
        }

        FireweaveError lastError = null;
        for (int attempt = 0; attempt < 2; attempt++) {
            try {
                postJson(REGISTER_TARGET_PATH, JsonValue.ofObject(body));
                return RegisterTargetResult.success();
            } catch (FireweaveException e) {
                lastError = FireweaveError.from(e);
                if (!lastError.retryable()) {
                    break;
                }
            } catch (RuntimeException e) {
                lastError = FireweaveError.of(ErrorKind.BackendUnavailable,
                        ErrorKind.BackendUnavailable.defaultMessage());
                break;
            }
        }
        return RegisterTargetResult.failure(lastError != null
                ? lastError
                : FireweaveError.of(ErrorKind.BackendUnavailable,
                        ErrorKind.BackendUnavailable.defaultMessage()));
    }

    @Override
    public void deliverExposure(Exposure exposure) {
        if (closed || !ready || exposure == null) {
            return;
        }
        Map<String, JsonValue> event = new LinkedHashMap<>();
        event.put("type", JsonValue.of("exposure"));
        event.put("targetingKey", JsonValue.of(exposure.targetingKey()));
        event.put("flagKey", JsonValue.of(exposure.flagKey()));
        event.put("value", exposure.value());
        if (exposure.variant() != null) {
            event.put("variant", JsonValue.of(exposure.variant()));
        }
        pending.add(event);
    }

    @Override
    public void deliverSignal(Signal signal) {
        if (closed || !ready || signal == null) {
            return;
        }
        Map<String, JsonValue> event = new LinkedHashMap<>();
        event.put("type", JsonValue.of("signal"));
        String targeting = signal.targetingKey() != null ? signal.targetingKey() : "fireweave-sdk";
        event.put("targetingKey", JsonValue.of(targeting));
        event.put("name", JsonValue.of(signal.name()));
        pending.add(event);
    }

    @Override
    public void onExposuresFlushed() {
        flushCapture();
    }

    @Override
    public Map<String, Boolean> runtimeFeatures() {
        Map<String, Boolean> m = new LinkedHashMap<>();
        m.put("remoteEvaluation", true);
        m.put("localEvaluation", false);
        m.put("localOnly", false);
        m.put("exposureEmission", true);
        m.put("sideEffectFreeReads", true);
        m.put("groupAnalytics", true);
        return Collections.unmodifiableMap(m);
    }

    @Override
    public void shutdown() {
        if (closed) {
            return;
        }
        closed = true;
        flushCapture();
        ready = false;
    }

    private void flushCapture() {
        if (!ready || pending.isEmpty()) {
            return;
        }
        List<Map<String, JsonValue>> batch = new ArrayList<>(pending);
        pending.clear();
        List<JsonValue> events = new ArrayList<>();
        for (Map<String, JsonValue> e : batch) {
            events.add(JsonValue.ofObject(e));
        }
        Map<String, JsonValue> body = new LinkedHashMap<>();
        body.put("events", JsonValue.ofArray(events));
        try {
            postJson(CAPTURE_PATH, JsonValue.ofObject(body));
        } catch (FireweaveException ignored) {
            pending.addAll(0, batch);
        }
    }

    private JsonValue postJson(String path, JsonValue body) throws FireweaveException {
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(apiUrl + path))
                .timeout(Duration.ofMillis(requestTimeoutMs))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + apiKey)
                .POST(HttpRequest.BodyPublishers.ofString(body.toCanonicalJson(), StandardCharsets.UTF_8))
                .build();
        try {
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            int status = response.statusCode();
            if (status == 401) {
                throw new FireweaveException(ErrorKind.Authentication);
            }
            if (status == 403) {
                throw new FireweaveException(ErrorKind.Authorization);
            }
            if (status == 429) {
                throw new FireweaveException(ErrorKind.RateLimited);
            }
            if (status >= 500) {
                throw new FireweaveException(ErrorKind.BackendUnavailable);
            }
            if (status >= 400) {
                throw new FireweaveException(ErrorKind.BackendUnavailable);
            }
            return MinimalJson.parse(response.body());
        } catch (FireweaveException e) {
            throw e;
        } catch (java.net.http.HttpTimeoutException e) {
            throw new FireweaveException(ErrorKind.Timeout, ErrorKind.Timeout.defaultMessage(), e);
        } catch (IOException e) {
            throw new FireweaveException(ErrorKind.Network, ErrorKind.Network.defaultMessage(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new FireweaveException(ErrorKind.Timeout, ErrorKind.Timeout.defaultMessage(), e);
        } catch (RuntimeException e) {
            throw new FireweaveException(ErrorKind.MalformedResponse, ErrorKind.MalformedResponse.defaultMessage(), e);
        }
    }

    private static Object toScalar(JsonValue v) {
        switch (v.kind()) {
            case BOOLEAN:
                return v.asBoolean();
            case NUMBER:
                return v.asNumber();
            case STRING:
                return v.asString();
            default:
                return null;
        }
    }

    /** Minimal JSON parser for Fireweave wire responses (no Jackson in core). */
    static final class MinimalJson {
        private final String s;
        private int i;

        private MinimalJson(String s) {
            this.s = s == null ? "" : s.trim();
        }

        static JsonValue parse(String raw) {
            MinimalJson p = new MinimalJson(raw);
            JsonValue v = p.parseValue();
            p.skipWs();
            if (p.i != p.s.length()) {
                throw new IllegalArgumentException("trailing input");
            }
            return v;
        }

        private JsonValue parseValue() {
            skipWs();
            if (i >= s.length()) {
                throw new IllegalArgumentException("unexpected end");
            }
            char c = s.charAt(i);
            if (c == '{') {
                return parseObject();
            }
            if (c == '[') {
                return parseArray();
            }
            if (c == '"') {
                return JsonValue.of(parseString());
            }
            if (c == 't' || c == 'f') {
                return JsonValue.of(parseLiteralBoolean());
            }
            if (c == 'n') {
                parseLiteral("null");
                return JsonValue.ofNull();
            }
            return JsonValue.of(parseNumber());
        }

        private JsonValue parseObject() {
            expect('{');
            Map<String, JsonValue> map = new LinkedHashMap<>();
            skipWs();
            if (peek('}')) {
                i++;
                return JsonValue.ofObject(map);
            }
            while (true) {
                skipWs();
                String key = parseString();
                skipWs();
                expect(':');
                map.put(key, parseValue());
                skipWs();
                if (peek('}')) {
                    i++;
                    return JsonValue.ofObject(map);
                }
                expect(',');
            }
        }

        private JsonValue parseArray() {
            expect('[');
            List<JsonValue> list = new ArrayList<>();
            skipWs();
            if (peek(']')) {
                i++;
                return JsonValue.ofArray(list);
            }
            while (true) {
                list.add(parseValue());
                skipWs();
                if (peek(']')) {
                    i++;
                    return JsonValue.ofArray(list);
                }
                expect(',');
            }
        }

        private String parseString() {
            expect('"');
            StringBuilder sb = new StringBuilder();
            while (i < s.length()) {
                char c = s.charAt(i++);
                if (c == '"') {
                    return sb.toString();
                }
                if (c == '\\') {
                    if (i >= s.length()) {
                        throw new IllegalArgumentException("bad escape");
                    }
                    char e = s.charAt(i++);
                    switch (e) {
                        case '"':
                        case '\\':
                        case '/':
                            sb.append(e);
                            break;
                        case 'b':
                            sb.append('\b');
                            break;
                        case 'f':
                            sb.append('\f');
                            break;
                        case 'n':
                            sb.append('\n');
                            break;
                        case 'r':
                            sb.append('\r');
                            break;
                        case 't':
                            sb.append('\t');
                            break;
                        case 'u':
                            if (i + 4 > s.length()) {
                                throw new IllegalArgumentException("bad unicode");
                            }
                            sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                            i += 4;
                            break;
                        default:
                            throw new IllegalArgumentException("bad escape");
                    }
                } else {
                    sb.append(c);
                }
            }
            throw new IllegalArgumentException("unterminated string");
        }

        private boolean parseLiteralBoolean() {
            if (s.startsWith("true", i)) {
                i += 4;
                return true;
            }
            if (s.startsWith("false", i)) {
                i += 5;
                return false;
            }
            throw new IllegalArgumentException("bad boolean");
        }

        private void parseLiteral(String lit) {
            if (!s.startsWith(lit, i)) {
                throw new IllegalArgumentException("expected " + lit);
            }
            i += lit.length();
        }

        private Number parseNumber() {
            int start = i;
            if (peek('-')) {
                i++;
            }
            while (i < s.length() && Character.isDigit(s.charAt(i))) {
                i++;
            }
            boolean frac = false;
            if (peek('.')) {
                frac = true;
                i++;
                while (i < s.length() && Character.isDigit(s.charAt(i))) {
                    i++;
                }
            }
            if (i < s.length() && (s.charAt(i) == 'e' || s.charAt(i) == 'E')) {
                frac = true;
                i++;
                if (peek('+') || peek('-')) {
                    i++;
                }
                while (i < s.length() && Character.isDigit(s.charAt(i))) {
                    i++;
                }
            }
            String num = s.substring(start, i);
            if (frac) {
                return Double.parseDouble(num);
            }
            long l = Long.parseLong(num);
            if (l >= Integer.MIN_VALUE && l <= Integer.MAX_VALUE) {
                return (int) l;
            }
            return l;
        }

        private void skipWs() {
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) {
                i++;
            }
        }

        private boolean peek(char c) {
            return i < s.length() && s.charAt(i) == c;
        }

        private void expect(char c) {
            skipWs();
            if (!peek(c)) {
                throw new IllegalArgumentException("expected " + c);
            }
            i++;
        }
    }
}
