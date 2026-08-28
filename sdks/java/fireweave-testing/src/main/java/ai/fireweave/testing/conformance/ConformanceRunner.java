package ai.fireweave.testing.conformance;

import ai.fireweave.sdk.application.EvaluationOptions;
import ai.fireweave.sdk.application.ExtensionResult;
import ai.fireweave.sdk.application.FireweaveClient;
import ai.fireweave.sdk.application.FireweaveConfig;
import ai.fireweave.sdk.application.FireweaveRuntime;
import ai.fireweave.sdk.domain.ContextLimits;
import ai.fireweave.sdk.domain.Decision;
import ai.fireweave.sdk.domain.ErrorKind;
import ai.fireweave.sdk.domain.EvaluationContext;
import ai.fireweave.sdk.domain.FireweaveException;
import ai.fireweave.sdk.domain.FlagType;
import ai.fireweave.sdk.domain.JsonValue;
import ai.fireweave.sdk.domain.LifecycleState;
import ai.fireweave.sdk.infrastructure.adapters.FireweaveRemoteAdapter;
import ai.fireweave.testing.FixtureHttpStub;
import ai.fireweave.testing.InMemoryAdapter;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.ObjectWriter;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Fireweave Java conformance runner (contracts/harness.md).
 *
 * <p>Loads all contracts/{evaluation,context,lifecycle,faults,security,extensions} fixtures,
 * invokes each against the real v1 control-points surface
 * ({@code FireweaveClient.controlPoints()} — no OpenFeature bridge; ADR-0010 retired
 * fireweave-openfeature and the old ConformanceIT pattern that depended on it), normalizes
 * results, and emits {@code compatibility-report.java.json} matching contracts/README.md's
 * schema. Exits non-zero on any fail.
 *
 * <h2>Backends</h2>
 * <ul>
 *   <li>evaluation / context / lifecycle / security / (the one runnable extensions fixture):
 *       {@link InMemoryAdapter}, driving {@link FireweaveRuntime} + {@link FireweaveClient}
 *       directly. Host-allowlist-testing lifecycle/security fixtures work unchanged here too:
 *       unlike go/python, java's {@link FireweaveConfig#host()} is validated by
 *       {@code FireweaveConfig.validate()} at the {@code FireweaveRuntime.initialize()} layer,
 *       independent of adapter choice.</li>
 *   <li>faults: {@link FireweaveRemoteAdapter} against a real in-process HTTP stub
 *       ({@link FixtureHttpStub}, pure JDK {@code com.sun.net.httpserver} — the canonical
 *       dockerized {@code maven:3.9-eclipse-temurin-21} image has no {@code node} binary to
 *       spawn test-server/implementation/server.mjs with, unlike node/python's runners).
 *       {@code fault-stale-cache} runs on the in-memory adapter instead (cache staleness is
 *       provisioned directly per {@code given.flags[*].fromCache} + providerState STALE).</li>
 *   <li>extensions: 13 of 14 fixtures target namespaces cut from v1 (releases, exposures,
 *       signals, capabilities) and are reported {@code skipped-v1-out-of-scope} without
 *       executing. Only {@code ext-unsupported-capability-degrade} exercises real v1 surface
 *       ({@code FireweaveClient.invokeCapability}) and runs for real.</li>
 * </ul>
 *
 * <p>Multi-case fixtures ({@code cases} array, contracts/README.md) run every case against a
 * fresh setup; the fixture passes only when all cases pass.
 */
public final class ConformanceRunner {

    private static final String LANGUAGE = "java";
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final List<String> SUITES = Arrays.asList(
            "evaluation", "context", "lifecycle", "faults", "security", "extensions");

    /**
     * Cut-in-v1 operations, mapped to the namespace they belong to (contracts/README.md
     * "Operations" table; contracts/harness.md "Extension fixtures — v1-scope rule", ruling 2).
     * Every namespace here (releases/exposures/signals/capabilities) is cut from the v1 surface
     * (ADR-0010); {@code invokeCapability} is deliberately absent — it is v1 surface, not cut.
     *
     * <p>A fixture is {@code skipped-v1-out-of-scope} when EVERY operation it dispatches — the
     * single top-level {@code when.operation}, or, for a multi-case fixture, every
     * {@code cases[].when.operation} — maps to an entry here. This derives the exact same
     * 13-out/1-real split a hand-maintained fixture-ID list used to encode (verified by
     * re-running the full suite: counts unchanged — see task-10-report.md's fix-report
     * addendum), including the one fixture worth reading individually rather than trusting the
     * name: {@code ext-lifecycle-gating}'s description ("lifecycle-gated... ruling 17") reads
     * like the {@code invokeCapability} lifecycle-gate exception this rule carves out, but all
     * three of its cases dispatch {@code emitSignal} (signals, cut), including a
     * "ready-delivered-to-sink" case expecting {@code ok:true} — an outcome
     * {@code invokeCapability} can never produce, since v1's supported-capabilities set is
     * frozen empty and the unsupported-capability check runs before the lifecycle gate in every
     * state. The operation-based rule classifies it correctly without needing that reasoning
     * spelled out in a lookup table.
     */
    private static final Map<String, String> CUT_OPERATION_NAMESPACE = new LinkedHashMap<>();

    static {
        CUT_OPERATION_NAMESPACE.put("setContext", "releases");
        CUT_OPERATION_NAMESPACE.put("start", "releases");
        CUT_OPERATION_NAMESPACE.put("complete", "releases");
        CUT_OPERATION_NAMESPACE.put("fail", "releases");
        CUT_OPERATION_NAMESPACE.put("recordExposure", "exposures");
        CUT_OPERATION_NAMESPACE.put("flushExposures", "exposures");
        CUT_OPERATION_NAMESPACE.put("emitSignal", "signals");
        CUT_OPERATION_NAMESPACE.put("getCapabilities", "capabilities");
    }

    /**
     * Returns the cut namespace name when every operation this fixture dispatches targets one,
     * or {@code null} when the fixture genuinely exercises v1 surface (today: only
     * ext-unsupported-capability-degrade).
     */
    private static String v1OutOfScopeNamespace(JsonNode fixture) {
        List<String> operations = new ArrayList<>();
        JsonNode cases = fixture.get("cases");
        if (cases != null && cases.isArray()) {
            for (JsonNode c : cases) {
                operations.add(c.path("when").path("operation").asText());
            }
        } else {
            operations.add(fixture.path("when").path("operation").asText());
        }
        String namespace = null;
        for (String op : operations) {
            String ns = CUT_OPERATION_NAMESPACE.get(op);
            if (ns == null) {
                return null;
            }
            if (namespace == null) {
                namespace = ns;
            }
        }
        return namespace;
    }

    private ConformanceRunner() {
    }

    // -------------------------------------------------------------------------------------
    // fixture loading

    public static List<JsonNode> loadFixtures(Path contractsDir) throws IOException {
        List<JsonNode> fixtures = new ArrayList<>();
        for (String suite : SUITES) {
            Path dir = contractsDir.resolve(suite);
            if (!Files.isDirectory(dir)) {
                continue;
            }
            List<Path> paths;
            try (Stream<Path> s = Files.list(dir)) {
                paths = s.filter(p -> p.toString().endsWith(".json")).sorted().collect(Collectors.toList());
            }
            for (Path p : paths) {
                fixtures.add(MAPPER.readTree(p.toFile()));
            }
        }
        return fixtures;
    }

    // -------------------------------------------------------------------------------------
    // JSON <-> domain conversions

    static JsonValue jsonValueFrom(JsonNode node) {
        if (node == null || node.isNull() || node.isMissingNode()) {
            return JsonValue.ofNull();
        }
        if (node.isBoolean()) {
            return JsonValue.of(node.booleanValue());
        }
        if (node.isIntegralNumber()) {
            return JsonValue.of(node.longValue());
        }
        if (node.isNumber()) {
            return JsonValue.of(node.doubleValue());
        }
        if (node.isTextual()) {
            return JsonValue.of(node.textValue());
        }
        if (node.isArray()) {
            List<JsonValue> items = new ArrayList<>();
            for (JsonNode child : node) {
                items.add(jsonValueFrom(child));
            }
            return JsonValue.ofArray(items);
        }
        if (node.isObject()) {
            Map<String, JsonValue> fields = new LinkedHashMap<>();
            Iterator<Map.Entry<String, JsonNode>> it = node.fields();
            while (it.hasNext()) {
                Map.Entry<String, JsonNode> e = it.next();
                fields.put(e.getKey(), jsonValueFrom(e.getValue()));
            }
            return JsonValue.ofObject(fields);
        }
        return JsonValue.ofNull();
    }

    static JsonNode toJsonNode(JsonValue v) {
        if (v == null) {
            return MAPPER.nullNode();
        }
        switch (v.kind()) {
            case NULL:
                return MAPPER.nullNode();
            case BOOLEAN:
                return MAPPER.getNodeFactory().booleanNode(v.asBoolean());
            case NUMBER: {
                Number n = v.asNumber();
                if (n instanceof Double || n instanceof Float) {
                    return MAPPER.getNodeFactory().numberNode(n.doubleValue());
                }
                return MAPPER.getNodeFactory().numberNode(n.longValue());
            }
            case STRING:
                return MAPPER.getNodeFactory().textNode(v.asString());
            case ARRAY: {
                ArrayNode arr = MAPPER.createArrayNode();
                for (JsonValue item : v.asArray()) {
                    arr.add(toJsonNode(item));
                }
                return arr;
            }
            case OBJECT: {
                ObjectNode obj = MAPPER.createObjectNode();
                for (Map.Entry<String, JsonValue> e : v.asObject().entrySet()) {
                    obj.set(e.getKey(), toJsonNode(e.getValue()));
                }
                return obj;
            }
            default:
                return MAPPER.nullNode();
        }
    }

    /**
     * Maps a fixture's declared flag type onto v1's four-member FlagType (boolean/string/
     * number/object) — v1 has no separate integer/float distinction
     * (conformance/surface/control-points.surface.json: "number, NOT integer"). NOTE:
     * eval-numeric-coercion-int-float specifically requests flagType "integer" against a
     * stored "float" value expecting TYPE_MISMATCH; collapsing both to "number" here means
     * the in-memory adapter's {@code def.type != request.type()} check can no longer see that
     * distinction, so this fixture fails for java the same way it does for go/python — a
     * v1-wide gap (every language's public surface only knows "number"), not a java-specific
     * bug. See task-10-report.md "Concerns".
     */
    static FlagType flagTypeFrom(String raw) {
        if ("integer".equals(raw) || "float".equals(raw)) {
            return FlagType.NUMBER;
        }
        return FlagType.fromCanonical(raw);
    }

    static EvaluationContext contextFrom(JsonNode spec) {
        EvaluationContext.Builder b = EvaluationContext.builder();
        if (spec == null || spec.isMissingNode() || spec.isNull()) {
            return b.build();
        }
        JsonNode tk = spec.get("targetingKey");
        if (tk != null && tk.isTextual()) {
            b.targetingKey(tk.asText());
        }
        JsonNode attrs = spec.get("attributes");
        if (attrs != null && attrs.isObject()) {
            Iterator<Map.Entry<String, JsonNode>> it = attrs.fields();
            while (it.hasNext()) {
                Map.Entry<String, JsonNode> e = it.next();
                String key = e.getKey();
                // Plain "groups"/"groupProperties" alias: java's SDK only auto-promotes the
                // canonical fireweave.groups/fireweave.groupProperties spelling
                // (Validation.promoteCanonicalKeys) inside validateContext, so the plain alias
                // is translated to first-class groups/groupProperties HERE instead of left as
                // a plain attribute (which the SDK would never promote).
                if ("groups".equals(key) && e.getValue().isObject()) {
                    Iterator<Map.Entry<String, JsonNode>> git = e.getValue().fields();
                    while (git.hasNext()) {
                        Map.Entry<String, JsonNode> g = git.next();
                        if (g.getValue().isTextual()) {
                            b.group(g.getKey(), g.getValue().asText());
                        }
                    }
                    continue;
                }
                if ("groupProperties".equals(key) && e.getValue().isObject()) {
                    Iterator<Map.Entry<String, JsonNode>> git = e.getValue().fields();
                    while (git.hasNext()) {
                        Map.Entry<String, JsonNode> g = git.next();
                        if (g.getValue().isObject()) {
                            Iterator<Map.Entry<String, JsonNode>> pit = g.getValue().fields();
                            while (pit.hasNext()) {
                                Map.Entry<String, JsonNode> p = pit.next();
                                b.groupProperty(g.getKey(), p.getKey(), jsonValueFrom(p.getValue()));
                            }
                        }
                    }
                    continue;
                }
                b.attribute(key, jsonValueFrom(e.getValue()));
            }
        }
        return b.build();
    }

    static ObjectNode contextToJson(EvaluationContext c) {
        ObjectNode out = MAPPER.createObjectNode();
        if (c == null) {
            return out;
        }
        if (c.targetingKey() != null) {
            out.put("targetingKey", c.targetingKey());
        }
        ObjectNode attrs = MAPPER.createObjectNode();
        for (Map.Entry<String, JsonValue> e : c.attributes().entrySet()) {
            if (e.getKey().startsWith("$")) {
                continue; // vendor directives are not context attributes
            }
            attrs.set(e.getKey(), toJsonNode(e.getValue()));
        }
        if (attrs.size() > 0) {
            out.set("attributes", attrs);
        }
        return out;
    }

    /** contracts/evaluation/eval-payload-attached.json's {@code when.options} (task-10b item 5)
     * -&gt; {@link EvaluationOptions}. */
    static EvaluationOptions evaluationOptionsFrom(JsonNode when) {
        JsonNode options = when.get("options");
        if (options == null || !options.isObject()) {
            return null;
        }
        return EvaluationOptions.withIncludePayload(options.path("includePayload").asBoolean(false));
    }

    static InMemoryAdapter.FlagDefinition flagDefinitionFrom(JsonNode node) {
        InMemoryAdapter.FlagDefinition def = new InMemoryAdapter.FlagDefinition();
        def.type = flagTypeFrom(node.path("type").asText("boolean"));
        def.enabled = node.path("enabled").asBoolean(true);
        if (node.hasNonNull("variant") && node.get("variant").isTextual()) {
            def.variant = node.get("variant").asText();
        }
        def.value = jsonValueFrom(node.get("value"));
        if (node.hasNonNull("payload")) {
            def.payload = jsonValueFrom(node.get("payload"));
        }
        if (node.hasNonNull("fireweaveReason")) {
            def.fireweaveReason = node.get("fireweaveReason").asText();
        }
        def.fromCache = node.path("fromCache").asBoolean(false);
        if (node.hasNonNull("matchTargetingKey")) {
            def.matchTargetingKey = node.get("matchTargetingKey").asText();
        }
        if (node.hasNonNull("matchAttribute") && node.get("matchAttribute").isObject()) {
            def.matchAttribute = new LinkedHashMap<>();
            Iterator<Map.Entry<String, JsonNode>> it = node.get("matchAttribute").fields();
            while (it.hasNext()) {
                Map.Entry<String, JsonNode> e = it.next();
                def.matchAttribute.put(e.getKey(), jsonValueFrom(e.getValue()));
            }
        }
        if (node.hasNonNull("matchGroups") && node.get("matchGroups").isObject()) {
            def.matchGroups = new LinkedHashMap<>();
            Iterator<Map.Entry<String, JsonNode>> it = node.get("matchGroups").fields();
            while (it.hasNext()) {
                Map.Entry<String, JsonNode> e = it.next();
                if (e.getValue().isTextual()) {
                    def.matchGroups.put(e.getKey(), e.getValue().asText());
                }
            }
        }
        if (node.hasNonNull("matchPerson") && node.get("matchPerson").isObject()) {
            def.matchPerson = new LinkedHashMap<>();
            Iterator<Map.Entry<String, JsonNode>> it = node.get("matchPerson").fields();
            while (it.hasNext()) {
                Map.Entry<String, JsonNode> e = it.next();
                def.matchPerson.put(e.getKey(), jsonValueFrom(e.getValue()));
            }
        }
        JsonNode reason = node.get("reason");
        if (reason != null && reason.isObject()) {
            if (reason.hasNonNull("code")) {
                def.reasonCode = reason.get("code").asText();
            }
            if (reason.hasNonNull("condition_index") && reason.get("condition_index").isIntegralNumber()) {
                def.conditionIndex = reason.get("condition_index").intValue();
            }
        }
        JsonNode metadata = node.get("metadata");
        if (metadata != null && metadata.isObject()) {
            if (metadata.hasNonNull("version") && metadata.get("version").isIntegralNumber()) {
                def.version = metadata.get("version").longValue();
            }
            if (metadata.hasNonNull("id") && metadata.get("id").isIntegralNumber()) {
                def.vendorId = metadata.get("id").longValue();
            }
        }
        return def;
    }

    static Map<String, InMemoryAdapter.FlagDefinition> flagsFrom(JsonNode given) {
        Map<String, InMemoryAdapter.FlagDefinition> out = new LinkedHashMap<>();
        JsonNode flags = given.get("flags");
        if (flags != null && flags.isObject()) {
            Iterator<Map.Entry<String, JsonNode>> it = flags.fields();
            while (it.hasNext()) {
                Map.Entry<String, JsonNode> e = it.next();
                out.put(e.getKey(), flagDefinitionFrom(e.getValue()));
            }
        }
        return out;
    }

    static JsonValue defaultValueFrom(JsonNode when) {
        return jsonValueFrom(when.get("defaultValue"));
    }

    static void applyConfigLimits(FireweaveConfig.Builder cfgBuilder, JsonNode config) {
        if (config == null) {
            return;
        }
        if (config.has("requireTargetingKey")) {
            cfgBuilder.requireTargetingKey(config.get("requireTargetingKey").asBoolean());
        }
        JsonNode limits = config.get("limits");
        if (limits != null && limits.isObject()) {
            ContextLimits.Builder lb = ContextLimits.builder();
            if (limits.has("maxAttributeCount")) {
                lb.maxAttributeCount(limits.get("maxAttributeCount").asInt());
            }
            if (limits.has("maxKeyBytes")) {
                lb.maxKeyBytes(limits.get("maxKeyBytes").asInt());
            }
            if (limits.has("maxValueBytes")) {
                lb.maxValueBytes(limits.get("maxValueBytes").asInt());
            }
            if (limits.has("maxNestingDepth")) {
                lb.maxNestingDepth(limits.get("maxNestingDepth").asInt());
            }
            if (limits.has("maxSerializedContextBytes")) {
                lb.maxSerializedBytes(limits.get("maxSerializedContextBytes").asInt());
            }
            cfgBuilder.limits(lb.build());
        }
    }

    static FireweaveException faultToException(JsonNode fault) {
        String mode = fault.path("mode").asText();
        switch (mode) {
            case "httpStatus": {
                int status = fault.path("status").asInt(500);
                if (status == 401) {
                    return new FireweaveException(ErrorKind.Authentication);
                }
                if (status == 403) {
                    return new FireweaveException(ErrorKind.Authorization);
                }
                if (status == 429) {
                    return new FireweaveException(ErrorKind.RateLimited);
                }
                return new FireweaveException(ErrorKind.BackendUnavailable);
            }
            case "networkError":
            case "offline":
                return new FireweaveException(ErrorKind.Network);
            case "timeout":
                return new FireweaveException(ErrorKind.Timeout);
            case "invalidJson":
            case "malformedJson":
            case "truncated":
                return new FireweaveException(ErrorKind.MalformedResponse);
            default:
                return new FireweaveException(ErrorKind.Internal);
        }
    }

    static String stateName(LifecycleState s) {
        switch (s) {
            case UNINITIALIZED:
            case INITIALIZING:
                return "NOT_READY";
            case READY:
                return "READY";
            case STALE:
                return "STALE";
            case ERROR:
                return "ERROR";
            case FATAL:
                return "FATAL";
            case SHUTDOWN:
                return "CLOSED";
            default:
                return s.name();
        }
    }

    static String textOrNull(JsonNode node, String field) {
        JsonNode v = node.get(field);
        return v != null && v.isTextual() ? v.asText() : null;
    }

    static ObjectNode decisionToActual(Decision d) {
        ObjectNode out = MAPPER.createObjectNode();
        out.set("value", toJsonNode(d.value()));
        if (d.variant() == null) {
            out.set("variant", MAPPER.nullNode());
        } else {
            out.put("variant", d.variant());
        }
        out.put("reason", d.reason());
        if (d.error() != null) {
            out.put("errorCode", d.error().openFeatureErrorCode());
            out.put("errorMessage", d.error().message());
        } else {
            out.set("errorCode", MAPPER.nullNode());
            out.set("errorMessage", MAPPER.nullNode());
        }
        ObjectNode meta = MAPPER.createObjectNode();
        for (Map.Entry<String, Object> e : d.flagMetadata().entrySet()) {
            Object v = e.getValue();
            if (v instanceof Boolean) {
                meta.put(e.getKey(), (Boolean) v);
            } else if (v instanceof Long || v instanceof Integer) {
                meta.put(e.getKey(), ((Number) v).longValue());
            } else if (v instanceof Number) {
                meta.put(e.getKey(), ((Number) v).doubleValue());
            } else {
                meta.put(e.getKey(), String.valueOf(v));
            }
        }
        if (meta.size() > 0) {
            out.set("flagMetadata", meta);
        }
        return out;
    }

    // -------------------------------------------------------------------------------------
    // lifecycle provisioning

    static void provisionState(FireweaveRuntime runtime, InMemoryAdapter adapter, String state) {
        if (state == null) {
            return; // NOT_READY / absent: leave UNINITIALIZED
        }
        switch (state) {
            case "READY":
                runtime.initialize();
                break;
            case "STALE":
                runtime.initialize();
                adapter.setStale(true);
                break;
            case "CLOSED":
                try {
                    runtime.initialize();
                } catch (FireweaveException ignored) {
                    // intentional: CLOSED fixtures only need the SHUTDOWN state reachable
                }
                runtime.shutdown();
                break;
            case "NOT_READY":
            default:
                break;
        }
    }

    // -------------------------------------------------------------------------------------
    // per-suite executors

    static ObjectNode executeEvaluate(JsonNode fixture) {
        JsonNode given = fixture.path("given");
        JsonNode when = fixture.path("when");

        // Multi-domain lifecycle fixture support: independent runtime/client per domain (no
        // OpenFeature domain multiplexing to reach for post-ADR-0010).
        if (given.has("domains")) {
            String requested = textOrNull(when, "domain");
            ObjectNode output = MAPPER.createObjectNode();
            Iterator<Map.Entry<String, JsonNode>> it = given.get("domains").fields();
            while (it.hasNext()) {
                Map.Entry<String, JsonNode> e = it.next();
                String name = e.getKey();
                JsonNode domainGiven = e.getValue();
                InMemoryAdapter adapter = new InMemoryAdapter(flagsFrom(domainGiven));
                FireweaveRuntime runtime = new FireweaveRuntime(FireweaveConfig.builder().build(), adapter);
                provisionState(runtime, adapter, textOrNull(domainGiven, "providerState"));
                if (name.equals(requested)) {
                    FireweaveClient client = new FireweaveClient(runtime);
                    Decision d = client.controlPoints().evaluate(
                            when.get("flagKey").asText(),
                            flagTypeFrom(when.get("flagType").asText()),
                            defaultValueFrom(when),
                            contextFrom(when.get("invocationContext")),
                            null);
                    output = decisionToActual(d);
                }
            }
            return output;
        }

        JsonNode config = given.get("config");
        FireweaveConfig.Builder cfgBuilder = FireweaveConfig.builder();
        if (given.has("globalContext")) {
            cfgBuilder.globalContext(contextFrom(given.get("globalContext")));
        }
        applyConfigLimits(cfgBuilder, config);

        InMemoryAdapter adapter = new InMemoryAdapter(flagsFrom(given));
        // Security-suite fixtures declare protocol faults but run on the in-memory adapter:
        // model them as a thrown FireweaveException of the equivalent kind (mirrors node/go/
        // python). Faults scoped to other endpoints (e.g. fault-stale-cache's applyTo:
        // "definitions") do not affect evaluation reads.
        JsonNode fault = given.get("fault");
        if (fault != null && (!fault.has("applyTo") || "flags".equals(fault.path("applyTo").asText()))) {
            adapter.setFault(faultToException(fault));
        }

        FireweaveRuntime runtime = new FireweaveRuntime(cfgBuilder.build(), adapter);
        EvaluationContext clientCtx = contextFrom(given.get("clientContext"));
        FireweaveClient client = new FireweaveClient(runtime, clientCtx);

        provisionState(runtime, adapter, textOrNull(given, "providerState"));

        EvaluationContext invocationCtx = contextFrom(when.get("invocationContext"));
        Decision d = client.controlPoints().evaluate(
                when.get("flagKey").asText(), flagTypeFrom(when.get("flagType").asText()),
                defaultValueFrom(when), invocationCtx, evaluationOptionsFrom(when));
        ObjectNode actual = decisionToActual(d);

        JsonNode expect = fixture.get("expect");
        if (expect != null && expect.has("contextSnapshotAfter")) {
            JsonNode raw = when.get("invocationContext");
            ObjectNode snap = MAPPER.createObjectNode();
            if (raw != null && raw.hasNonNull("targetingKey") && raw.get("targetingKey").isTextual()) {
                snap.put("targetingKey", raw.get("targetingKey").asText());
            }
            if (raw != null && raw.has("attributes")) {
                snap.set("attributes", raw.get("attributes"));
            }
            actual.set("contextSnapshotAfter", snap);
        }
        if (expect != null && expect.has("resolvedContext")) {
            actual.set("resolvedContext", contextToJson(adapter.lastContext()));
        }
        if (expect != null && expect.has("networkCalls")) {
            actual.put("networkCalls", adapter.resolveCount());
        }
        return actual;
    }

    static ObjectNode executeInitialize(JsonNode fixture) {
        JsonNode given = fixture.path("given");
        JsonNode config = given.get("config");
        FireweaveConfig.Builder cfgBuilder = FireweaveConfig.builder();
        if (config != null) {
            if (config.hasNonNull("projectApiKey")) {
                cfgBuilder.projectApiKey(config.get("projectApiKey").asText());
            }
            if (config.hasNonNull("host")) {
                cfgBuilder.host(config.get("host").asText());
            }
            if (config.hasNonNull("allowedHosts") && config.get("allowedHosts").isArray()) {
                Set<String> hosts = new LinkedHashSet<>();
                for (JsonNode h : config.get("allowedHosts")) {
                    if (h.isTextual()) {
                        hosts.add(h.asText());
                    }
                }
                cfgBuilder.allowedHosts(hosts);
            }
        }
        InMemoryAdapter adapter = InMemoryAdapter.empty();
        FireweaveRuntime runtime = new FireweaveRuntime(cfgBuilder.build(), adapter);

        FireweaveException initErr = null;
        try {
            runtime.initialize();
        } catch (FireweaveException e) {
            initErr = e;
        }

        ObjectNode actual = MAPPER.createObjectNode();
        actual.put("providerState", stateName(runtime.state()));
        if (initErr != null) {
            actual.put("errorCode", initErr.openFeatureErrorCode());
            actual.put("errorMessage", initErr.getMessage());
            JsonNode expect = fixture.get("expect");
            if (expect != null && expect.has("errorKind")) {
                actual.put("errorKind", initErr.kind().name());
            }
        } else {
            actual.set("errorCode", MAPPER.nullNode());
            actual.set("errorMessage", MAPPER.nullNode());
        }
        runtime.shutdown();
        return actual;
    }

    static ObjectNode executeShutdown(JsonNode fixture) {
        JsonNode given = fixture.path("given");
        InMemoryAdapter adapter = new InMemoryAdapter(flagsFrom(given));
        FireweaveRuntime runtime = new FireweaveRuntime(FireweaveConfig.builder().build(), adapter);
        provisionState(runtime, adapter, textOrNull(given, "providerState"));

        RuntimeException shutdownErr = null;
        try {
            runtime.shutdown();
        } catch (RuntimeException e) {
            shutdownErr = e;
        }
        ObjectNode actual = MAPPER.createObjectNode();
        actual.put("providerState", stateName(runtime.state()));
        if (shutdownErr != null) {
            actual.put("errorCode", "GENERAL");
            actual.put("errorMessage", shutdownErr.getMessage());
        } else {
            actual.set("errorCode", MAPPER.nullNode());
            actual.set("errorMessage", MAPPER.nullNode());
        }
        return actual;
    }

    static ObjectNode executeReplaceProvider(JsonNode fixture) {
        JsonNode given = fixture.path("given");
        JsonNode when = fixture.path("when");

        InMemoryAdapter adapterA = new InMemoryAdapter(flagsFrom(given));
        FireweaveRuntime runtimeA = new FireweaveRuntime(FireweaveConfig.builder().build(), adapterA);
        runtimeA.initialize();
        runtimeA.shutdown(); // old provider retired before the replacement takes over

        JsonNode replacement = given.get("replacement");
        Map<String, InMemoryAdapter.FlagDefinition> replacementFlags = new LinkedHashMap<>();
        if (replacement != null && replacement.has("flags")) {
            Iterator<Map.Entry<String, JsonNode>> it = replacement.get("flags").fields();
            while (it.hasNext()) {
                Map.Entry<String, JsonNode> e = it.next();
                replacementFlags.put(e.getKey(), flagDefinitionFrom(e.getValue()));
            }
        }
        InMemoryAdapter adapterB = new InMemoryAdapter(replacementFlags);
        FireweaveRuntime runtimeB = new FireweaveRuntime(FireweaveConfig.builder().build(), adapterB);
        runtimeB.initialize();
        FireweaveClient clientB = new FireweaveClient(runtimeB);

        JsonNode then = when.get("thenEvaluate");
        Decision d = clientB.controlPoints().evaluate(
                then.get("flagKey").asText(), flagTypeFrom(then.get("flagType").asText()),
                defaultValueFrom(then), contextFrom(then.get("invocationContext")), null);
        ObjectNode actual = decisionToActual(d);
        actual.put("providerState", stateName(runtimeB.state()));
        runtimeB.shutdown();
        return actual;
    }

    /**
     * Only ext-unsupported-capability-degrade reaches here (see
     * CUT_OPERATION_NAMESPACE/v1OutOfScopeNamespace above).
     */
    static ObjectNode executeInvokeCapability(JsonNode fixture) {
        JsonNode given = fixture.path("given");
        JsonNode when = fixture.path("when");
        InMemoryAdapter adapter = new InMemoryAdapter(flagsFrom(given));
        FireweaveRuntime runtime = new FireweaveRuntime(FireweaveConfig.builder().build(), adapter);
        FireweaveClient client = new FireweaveClient(runtime);

        String state = textOrNull(given, "providerState");
        if (state == null) {
            state = "READY";
        }
        switch (state) {
            case "NOT_READY":
                break;
            case "CLOSED":
                runtime.initialize();
                runtime.shutdown();
                break;
            default:
                runtime.initialize();
        }

        Map<String, Object> args = new LinkedHashMap<>();
        JsonNode argsNode = when.get("args");
        if (argsNode != null && argsNode.isObject()) {
            Iterator<Map.Entry<String, JsonNode>> it = argsNode.fields();
            while (it.hasNext()) {
                Map.Entry<String, JsonNode> e = it.next();
                args.put(e.getKey(), jsonValueFrom(e.getValue()));
            }
        }
        ExtensionResult<Object> result = client.invokeCapability(when.get("capability").asText(), args);
        ObjectNode actual = MAPPER.createObjectNode();
        actual.put("ok", result.isOk());
        if (result.isOk()) {
            actual.set("errorCode", MAPPER.nullNode());
        } else {
            actual.put("errorCode", result.error().openFeatureErrorCode());
            actual.put("errorMessage", result.error().message());
            actual.put("errorKind", result.error().kind().name());
            if (result.isDegraded()) {
                actual.put("degraded", true);
            }
        }
        if (!"CLOSED".equals(state)) {
            runtime.shutdown();
        }
        return actual;
    }

    /**
     * Exercises the remote adapter's real HTTP path (POST /v1/flags/evaluate). Baseline: an
     * in-process HTTP stub ({@link FixtureHttpStub}, pure JDK) — the canonical dockerized
     * maven:3.9-eclipse-temurin-21 image has no {@code node} binary to spawn
     * test-server/implementation/server.mjs with, unlike node/python's runners.
     */
    static ObjectNode executeFault(JsonNode fixture) throws IOException {
        JsonNode given = fixture.path("given");
        JsonNode when = fixture.path("when");
        JsonNode fault = given.get("fault");
        String mode = fault != null ? fault.path("mode").asText("none") : "none";

        // Stale-cache runs on the in-memory adapter (cache state provisioned directly).
        if ("fault-stale-cache".equals(fixture.get("id").asText())) {
            return executeEvaluate(fixture);
        }

        String apiKey = "phc_TESTKEY0000000000000000000001";
        JsonNode config = given.get("config");
        if (config != null && config.hasNonNull("projectApiKey")) {
            apiKey = config.get("projectApiKey").asText();
        }
        int timeoutMs = 3000;
        if (config != null && config.hasNonNull("featureFlagsRequestTimeoutMs")) {
            timeoutMs = config.get("featureFlagsRequestTimeoutMs").asInt(3000);
        }

        String apiUrl;
        FixtureHttpStub stub = null;
        if ("networkError".equals(mode) || "offline".equals(mode)) {
            // A dead loopback port: a real ECONNREFUSED, no stub involved.
            apiUrl = deadLoopbackUrl();
        } else {
            stub = FixtureHttpStub.start();
            FixtureHttpStub.Fault f = new FixtureHttpStub.Fault();
            switch (mode) {
                case "httpStatus":
                    f.mode = "httpStatus";
                    f.status = fault.path("status").asInt(500);
                    break;
                case "invalidJson":
                    f.mode = "invalidJson";
                    f.body = fault.hasNonNull("body") ? fault.get("body").asText() : "{not-json";
                    break;
                case "delay":
                    f.mode = "delay";
                    f.delayMs = fault.hasNonNull("delayMs") ? fault.get("delayMs").asLong() : 1000L;
                    break;
                case "quotaLimited":
                    f.mode = "quotaLimited";
                    break;
                default:
                    f.mode = "none";
            }
            stub.setFault(f);
            apiUrl = stub.url();
        }

        try {
            // The default host allowlist ("usingDefaultAllowlist" escape hatch in
            // FireweaveRemoteAdapter.initialize) permits any host when allowedHosts is left
            // unset, so no explicit allowedHosts override is needed for the loopback stub URL.
            FireweaveConfig runtimeConfig = FireweaveConfig.builder()
                    .host(apiUrl)
                    .projectApiKey(apiKey)
                    .requestTimeoutMs(timeoutMs)
                    .build();
            FireweaveRemoteAdapter adapter = new FireweaveRemoteAdapter();
            FireweaveRuntime runtime = new FireweaveRuntime(runtimeConfig, adapter);
            runtime.initialize();
            FireweaveClient client = new FireweaveClient(runtime);
            Decision d = client.controlPoints().evaluate(
                    when.get("flagKey").asText(), flagTypeFrom(when.get("flagType").asText()),
                    defaultValueFrom(when), contextFrom(when.get("invocationContext")), null);
            runtime.shutdown();
            return decisionToActual(d);
        } finally {
            if (stub != null) {
                stub.close();
            }
        }
    }

    static String deadLoopbackUrl() throws IOException {
        try (ServerSocket socket = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
            return "http://127.0.0.1:" + socket.getLocalPort();
        }
    }

    // -------------------------------------------------------------------------------------
    // comparator (contracts/harness.md, normative)

    /**
     * Deep-equal comparison treating numeric nodes by VALUE regardless of exact Jackson node
     * type (IntNode vs LongNode vs DoubleNode) — Jackson's own {@code JsonNode.equals()} is
     * type-sensitive and would false-fail e.g. IntNode(3) vs LongNode(3).
     */
    static boolean deepEqual(JsonNode a, JsonNode b) {
        if (a == null) {
            a = MAPPER.nullNode();
        }
        if (b == null) {
            b = MAPPER.nullNode();
        }
        if (a.isNull() || b.isNull()) {
            return a.isNull() && b.isNull();
        }
        if (a.isNumber() && b.isNumber()) {
            if (a.isIntegralNumber() && b.isIntegralNumber()) {
                return a.longValue() == b.longValue();
            }
            return a.doubleValue() == b.doubleValue();
        }
        if (a.isBoolean() && b.isBoolean()) {
            return a.booleanValue() == b.booleanValue();
        }
        if (a.isTextual() && b.isTextual()) {
            return a.textValue().equals(b.textValue());
        }
        if (a.isArray() && b.isArray()) {
            if (a.size() != b.size()) {
                return false;
            }
            for (int i = 0; i < a.size(); i++) {
                if (!deepEqual(a.get(i), b.get(i))) {
                    return false;
                }
            }
            return true;
        }
        if (a.isObject() && b.isObject()) {
            if (a.size() != b.size()) {
                return false;
            }
            Iterator<String> names = a.fieldNames();
            while (names.hasNext()) {
                String name = names.next();
                if (!b.has(name) || !deepEqual(a.get(name), b.get(name))) {
                    return false;
                }
            }
            return true;
        }
        return false;
    }

    /**
     * Compares `expect` vs `actual` per the normative comparator (contracts/README.md): every
     * declared expect key must match; missing key -> fail. Mirrors node/python's comparator —
     * neither fails on EXTRA actual keys beyond what a fixture declares; that stricter rule is
     * go-specific precedent, not replicated here.
     */
    static List<String> compare(ObjectNode actual, JsonNode expect) {
        List<String> failures = new ArrayList<>();
        if (expect == null) {
            return failures;
        }
        Iterator<Map.Entry<String, JsonNode>> it = expect.fields();
        while (it.hasNext()) {
            Map.Entry<String, JsonNode> e = it.next();
            String key = e.getKey();
            if ("errorMessageMustNotContain".equals(key) || "recordedMessageMustNotContain".equals(key)) {
                continue;
            }
            JsonNode expected = e.getValue();
            JsonNode actualValue = actual.get(key);
            if (expected == null || expected.isNull()) {
                if (actualValue != null && !actualValue.isNull()) {
                    failures.add(key + ": expected null, got " + actualValue);
                }
                continue;
            }
            if (actualValue == null || !deepEqual(actualValue, expected)) {
                failures.add(key + ": expected " + expected + ", got " + actualValue);
            }
        }
        JsonNode mustNot = expect.get("errorMessageMustNotContain");
        if (mustNot != null && mustNot.isArray()) {
            String message = actual.hasNonNull("errorMessage") ? actual.get("errorMessage").asText() : "";
            for (JsonNode needle : mustNot) {
                if (needle.isTextual() && message.contains(needle.asText())) {
                    failures.add("errorMessage must not contain " + needle.asText());
                }
            }
        }
        return failures;
    }

    // -------------------------------------------------------------------------------------
    // fixture execution

    static ObjectNode dispatch(JsonNode fixture) throws IOException {
        String suite = fixture.get("suite").asText();
        if ("faults".equals(suite)) {
            return executeFault(fixture);
        }
        String operation = fixture.path("when").path("operation").asText();
        switch (operation) {
            case "evaluate":
                return executeEvaluate(fixture);
            case "initialize":
                return executeInitialize(fixture);
            case "shutdown":
                return executeShutdown(fixture);
            case "replaceProvider":
                return executeReplaceProvider(fixture);
            case "invokeCapability":
                return executeInvokeCapability(fixture);
            default:
                throw new IllegalStateException("unsupported operation " + operation
                        + " (should have been classified skipped-v1-out-of-scope)");
        }
    }

    static ObjectNode mergeGiven(JsonNode fixture, JsonNode caseNode) {
        ObjectNode merged = MAPPER.createObjectNode();
        merged.put("id", fixture.get("id").asText());
        merged.put("suite", fixture.get("suite").asText());
        ObjectNode givenMerged = ((ObjectNode) fixture.path("given")).deepCopy();
        JsonNode caseGiven = caseNode.get("given");
        if (caseGiven != null && caseGiven.isObject()) {
            Iterator<Map.Entry<String, JsonNode>> it = caseGiven.fields();
            while (it.hasNext()) {
                Map.Entry<String, JsonNode> e = it.next();
                givenMerged.set(e.getKey(), e.getValue());
            }
        }
        merged.set("given", givenMerged);
        merged.set("when", caseNode.get("when"));
        merged.set("expect", caseNode.get("expect"));
        return merged;
    }

    /**
     * Runs one fixture; returns a report row matching contracts/README.md's compatibility-report
     * schema (fixtureId/suite/language/status/limitation/message).
     */
    public static ObjectNode runFixture(JsonNode fixture) {
        String id = fixture.get("id").asText();
        String suite = fixture.get("suite").asText();
        ObjectNode row = MAPPER.createObjectNode();
        row.put("fixtureId", id);
        row.put("suite", suite);
        row.put("language", LANGUAGE);

        // v1-scope rule (contracts/harness.md): extensions fixtures targeting a cut namespace
        // are reported skipped-v1-out-of-scope, never executed, regardless of the fixture's
        // own declared compatibility (frozen "pass", authored pre-cut).
        if ("extensions".equals(suite)) {
            String namespace = v1OutOfScopeNamespace(fixture);
            if (namespace != null) {
                row.put("status", "skipped-v1-out-of-scope");
                row.put("limitation", "targets the " + namespace
                        + " namespace, cut from the v1 control-points surface (ADR-0010)");
                row.set("message", MAPPER.nullNode());
                return row;
            }
        }

        JsonNode compat = fixture.get("compatibility");
        String declared = compat != null && compat.hasNonNull(LANGUAGE) ? compat.get(LANGUAGE).asText() : null;
        if ("skipped-with-documented-limitation".equals(declared)) {
            row.put("status", "skipped-with-documented-limitation");
            JsonNode limitations = fixture.get("limitations");
            String lim = limitations != null && limitations.hasNonNull(LANGUAGE)
                    ? limitations.get(LANGUAGE).asText() : "documented limitation";
            row.put("limitation", lim);
            row.set("message", MAPPER.nullNode());
            return row;
        }

        List<String> messages = new ArrayList<>();
        boolean pass = true;

        if (fixture.has("cases") && fixture.get("cases").isArray()) {
            for (JsonNode cs : fixture.get("cases")) {
                String label = cs.hasNonNull("name") ? cs.get("name").asText() : null;
                String prefix = label != null ? "[" + label + "] " : "";
                try {
                    ObjectNode merged = mergeGiven(fixture, cs);
                    ObjectNode actual = dispatch(merged);
                    List<String> diffs = compare(actual, merged.get("expect"));
                    if (!diffs.isEmpty()) {
                        pass = false;
                        messages.add(prefix + String.join("; ", diffs));
                    }
                } catch (Exception e) {
                    pass = false;
                    messages.add(prefix + "harness error: " + e);
                }
            }
        } else {
            try {
                ObjectNode actual = dispatch(fixture);
                List<String> diffs = compare(actual, fixture.get("expect"));
                if (!diffs.isEmpty()) {
                    pass = false;
                    messages.add(String.join("; ", diffs));
                }
            } catch (Exception e) {
                pass = false;
                messages.add("harness error: " + e);
            }
        }

        row.put("status", pass ? "pass" : "fail");
        row.set("limitation", MAPPER.nullNode());
        row.set("message", messages.isEmpty() ? MAPPER.nullNode() : MAPPER.getNodeFactory().textNode(
                String.join(" | ", messages)));
        return row;
    }

    public static ObjectNode runAll(Path contractsDir) throws IOException {
        List<JsonNode> fixtures = loadFixtures(contractsDir);
        ArrayNode results = MAPPER.createArrayNode();
        int pass = 0;
        int fail = 0;
        int skipDoc = 0;
        int skipV1 = 0;
        int extensionsOutOfScope = 0;
        int extensionsRunnable = 0;
        for (JsonNode f : fixtures) {
            ObjectNode row = runFixture(f);
            results.add(row);
            String status = row.get("status").asText();
            switch (status) {
                case "pass":
                    pass++;
                    break;
                case "fail":
                    fail++;
                    break;
                case "skipped-with-documented-limitation":
                    skipDoc++;
                    break;
                case "skipped-v1-out-of-scope":
                    skipV1++;
                    break;
                default:
                    break;
            }
            if ("extensions".equals(f.get("suite").asText())) {
                if ("skipped-v1-out-of-scope".equals(status)) {
                    extensionsOutOfScope++;
                } else {
                    extensionsRunnable++;
                }
            }
        }

        // Sanity assertion (review finding 2): the data-driven v1-scope classification above
        // must derive the exact same 13-out/1-real split a hand-maintained fixture-ID list used
        // to encode. If contracts/extensions/ ever gains or loses a fixture, or a fixture's
        // operation set changes, this fails loudly instead of silently drifting.
        if (extensionsOutOfScope != 13 || extensionsRunnable != 1) {
            throw new IllegalStateException(String.format(
                    "v1-scope classification drifted: expected 13 skipped-v1-out-of-scope + 1 "
                            + "runnable extensions fixture, got %d + %d",
                    extensionsOutOfScope, extensionsRunnable));
        }

        ObjectNode report = MAPPER.createObjectNode();
        report.put("schemaVersion", 1);
        report.put("generatedAt", "EXCLUDED");
        report.put("sdkCommit", "workspace");
        report.put("contractsCommit", "workspace");
        report.set("results", results);
        ObjectNode summary = MAPPER.createObjectNode();
        summary.put("pass", pass);
        summary.put("fail", fail);
        summary.put("skipped-with-documented-limitation", skipDoc);
        summary.put("skipped-v1-out-of-scope", skipV1);
        report.set("summary", summary);
        return report;
    }

    /**
     * CLI entry: {@code java -cp ... ai.fireweave.testing.conformance.ConformanceRunner
     * <contractsDir> <outPath>} (exec-maven-plugin's configured mainClass). Exit status is
     * non-zero when any fixture fails.
     */
    public static void main(String[] args) throws IOException {
        Path contractsDir = args.length > 0 ? Paths.get(args[0]) : Paths.get("..", "..", "..", "contracts");
        Path outPath = args.length > 1 ? Paths.get(args[1]) : Paths.get("compatibility-report.java.json");

        ObjectNode report = runAll(contractsDir);
        ObjectWriter writer = MAPPER.writerWithDefaultPrettyPrinter();
        writer.writeValue(outPath.toFile(), report);

        JsonNode summary = report.get("summary");
        System.out.println("conformance[java]: " + summary.get("pass").asInt() + " passed, "
                + summary.get("fail").asInt() + " failed, "
                + summary.get("skipped-with-documented-limitation").asInt() + " skipped-with-documented-limitation, "
                + summary.get("skipped-v1-out-of-scope").asInt() + " skipped-v1-out-of-scope"
                + " (report: " + outPath + ")");
        for (JsonNode row : report.get("results")) {
            if ("fail".equals(row.get("status").asText())) {
                System.out.println("  FAIL " + row.get("suite").asText() + "/" + row.get("fixtureId").asText());
                JsonNode message = row.get("message");
                if (message != null && !message.isNull()) {
                    System.out.println("       - " + message.asText());
                }
            }
        }
        if (summary.get("fail").asInt() > 0) {
            System.exit(1);
        }
    }
}
