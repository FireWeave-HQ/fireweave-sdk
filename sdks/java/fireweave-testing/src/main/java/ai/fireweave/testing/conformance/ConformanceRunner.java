package ai.fireweave.testing.conformance;

import ai.fireweave.openfeature.FireweaveProvider;
import ai.fireweave.sdk.Capabilities;
import ai.fireweave.sdk.ContextLimits;
import ai.fireweave.sdk.Decision;
import ai.fireweave.sdk.ErrorKind;
import ai.fireweave.sdk.EvaluationOptions;
import ai.fireweave.sdk.Exposure;
import ai.fireweave.sdk.ExtensionResult;
import ai.fireweave.sdk.FireweaveClient;
import ai.fireweave.sdk.FireweaveConfig;
import ai.fireweave.sdk.FireweaveRuntime;
import ai.fireweave.sdk.FlagType;
import ai.fireweave.sdk.JsonValue;
import ai.fireweave.sdk.LifecycleState;
import ai.fireweave.sdk.ReleaseContext;
import ai.fireweave.sdk.Signal;
import ai.fireweave.testing.FaultConfig;
import ai.fireweave.testing.FlagDefinition;
import ai.fireweave.testing.InMemoryAdapter;
import ai.fireweave.testing.Json;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.openfeature.sdk.Client;
import dev.openfeature.sdk.FlagEvaluationDetails;
import dev.openfeature.sdk.ImmutableMetadata;
import dev.openfeature.sdk.MutableContext;
import dev.openfeature.sdk.OpenFeatureAPI;
import dev.openfeature.sdk.Value;

import java.io.IOException;
import java.lang.reflect.Field;
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
 * Conformance runner per contracts/harness.md: loads all fixtures under contracts/, provisions
 * the {@link InMemoryAdapter} from {@code given}, invokes {@code when} through the REAL
 * OpenFeature client + {@link FireweaveProvider}, normalizes, compares, and writes
 * {@code compatibility-report.java.json}.
 *
 * <p>Faults are simulated in-process by the InMemoryAdapter (the shared test-server stub at
 * test-server/implementation/ is not yet runnable); transport-level fault fixtures are annotated
 * in the report message.
 */
public final class ConformanceRunner {

    private static final String LANGUAGE = "java";
    private static final List<String> SUITES = Arrays.asList(
            "evaluation", "context", "lifecycle", "faults", "security", "extensions");
    private static final ObjectMapper M = new ObjectMapper();

    private final Path contractsDir;
    private final OpenFeatureAPI api = OpenFeatureAPI.getInstance();
    private int domainCounter;

    public ConformanceRunner(Path contractsDir) {
        this.contractsDir = contractsDir;
    }

    public static void main(String[] args) throws Exception {
        Path contracts = args.length > 0 ? Paths.get(args[0]) : findContractsDir();
        Path out = args.length > 1 ? Paths.get(args[1])
                : Paths.get("target", "compatibility-report.java.json");
        ConformanceRunner runner = new ConformanceRunner(contracts);

        ArrayNode results = M.createArrayNode();
        int pass = 0;
        int fail = 0;
        int skipped = 0;
        for (String suite : SUITES) {
            Path dir = contracts.resolve(suite);
            List<Path> files;
            try (Stream<Path> s = Files.list(dir)) {
                files = s.filter(p -> p.toString().endsWith(".json")).sorted().collect(Collectors.toList());
            }
            for (Path file : files) {
                JsonNode fixture = M.readTree(file.toFile());
                ObjectNode row = runner.runFixture(fixture, suite);
                results.add(row);
                switch (row.get("status").asText()) {
                    case "pass":
                        pass++;
                        break;
                    case "fail":
                        fail++;
                        break;
                    default:
                        skipped++;
                }
            }
        }

        ObjectNode report = M.createObjectNode();
        report.put("schemaVersion", 1);
        report.put("generatedAt", "EXCLUDED");
        report.set("results", results);
        ObjectNode summary = report.putObject("summary");
        summary.put("pass", pass);
        summary.put("fail", fail);
        summary.put("skipped-with-documented-limitation", skipped);

        Files.createDirectories(out.toAbsolutePath().getParent());
        Files.write(out, M.writerWithDefaultPrettyPrinter().writeValueAsBytes(report));

        System.out.println("conformance: pass=" + pass + " fail=" + fail + " skipped=" + skipped
                + " total=" + (pass + fail + skipped));
        if (fail > 0) {
            for (JsonNode row : results) {
                if ("fail".equals(row.get("status").asText())) {
                    System.out.println("FAIL " + row.get("fixtureId").asText() + ": "
                            + row.path("message").asText());
                }
            }
            System.exit(1);
        }
    }

    private static Path findContractsDir() {
        Path p = Paths.get("").toAbsolutePath();
        while (p != null) {
            Path candidate = p.resolve("contracts");
            if (Files.exists(candidate.resolve("harness.md"))) {
                return candidate;
            }
            p = p.getParent();
        }
        throw new IllegalStateException("contracts/ directory not found upward from CWD");
    }

    ObjectNode runFixture(JsonNode fixture, String suite) {
        String id = fixture.path("id").asText();
        ObjectNode row = M.createObjectNode();
        row.put("fixtureId", id);
        row.put("suite", suite);
        row.put("language", LANGUAGE);

        String declared = fixture.path("compatibility").path(LANGUAGE).asText("pass");
        if ("skipped-with-documented-limitation".equals(declared)) {
            row.put("status", "skipped-with-documented-limitation");
            row.put("limitation", fixture.path("limitations").path(LANGUAGE).asText(""));
            row.putNull("message");
            return row;
        }

        try {
            Execution exec = execute(fixture);
            List<String> problems = new ArrayList<>(FixtureComparator.compare(fixture.get("expect"), exec.actual));
            problems.addAll(exec.extraProblems);
            if (problems.isEmpty()) {
                row.put("status", "pass");
                row.putNull("limitation");
                if (exec.note != null) {
                    row.put("message", exec.note);
                } else {
                    row.putNull("message");
                }
            } else {
                row.put("status", "fail");
                row.putNull("limitation");
                row.put("message", String.join("; ", problems)
                        + " | actual=" + exec.actual.toString());
            }
        } catch (Exception e) {
            row.put("status", "fail");
            row.putNull("limitation");
            row.put("message", "runner exception: " + e);
        }
        return row;
    }

    private static final class Execution {
        final ObjectNode actual;
        final List<String> extraProblems = new ArrayList<>();
        String note;

        Execution(ObjectNode actual) {
            this.actual = actual;
        }
    }

    /** Per-fixture environment. */
    private static final class Env {
        FireweaveConfig config;
        InMemoryAdapter adapter;
        FireweaveRuntime runtime;
        FireweaveProvider provider;
        Client ofClient;
        FireweaveClient fwClient;
        String domain;
    }

    private Execution execute(JsonNode fixture) throws Exception {
        JsonNode given = fixture.path("given");
        JsonNode when = fixture.path("when");
        JsonNode expect = fixture.path("expect");
        String op = when.path("operation").asText();

        if (given.has("domains")) {
            return executeMultiDomain(given, when, expect);
        }

        boolean deferProviderRegistration = "initialize".equals(op);
        Env env = buildEnv(given, when, "");

        if (!deferProviderRegistration) {
            registerProvider(env, given);
        }

        switch (op) {
            case "evaluate":
                return doEvaluate(env, when, expect);
            case "initialize": {
                try {
                    api.setProviderAndWait(env.domain, env.provider);
                } catch (Throwable t) {
                    // Failure surface is read from the runtime below.
                }
                ObjectNode actual = M.createObjectNode();
                actual.put("providerState", mapState(env.runtime.state()));
                if (env.runtime.lastError() != null) {
                    actual.put("errorCode", env.runtime.lastError().openFeatureErrorCode());
                    actual.put("errorMessage", env.runtime.lastError().message());
                    actual.put("errorKind", env.runtime.lastError().kind().name());
                } else {
                    actual.putNull("errorCode");
                    actual.putNull("errorMessage");
                }
                return new Execution(actual);
            }
            case "shutdown": {
                env.provider.shutdown();
                ObjectNode actual = M.createObjectNode();
                actual.put("providerState", mapState(env.runtime.state()));
                actual.putNull("errorCode");
                actual.putNull("errorMessage");
                return new Execution(actual);
            }
            case "replaceProvider": {
                Env replacement = buildEnv(given.path("replacement"), when, "-replacement");
                replacement.domain = env.domain;
                api.setProviderAndWait(env.domain, replacement.provider);
                replacement.ofClient = api.getClient(env.domain);
                Execution exec = doEvaluate(replacement, when.path("thenEvaluate"), expect);
                exec.actual.put("providerState", mapState(replacement.runtime.state()));
                return exec;
            }
            case "setContext": {
                ReleaseContext rc = parseReleaseContext(when.path("release"));
                ExtensionResult<ReleaseContext> r = env.fwClient.releases().setContext(rc);
                ObjectNode actual = M.createObjectNode();
                actual.put("ok", r.isOk());
                if (r.isOk()) {
                    ObjectNode ctx = actual.putObject("releaseContext");
                    ctx.put("rolloutId", r.value().rolloutId());
                    ctx.put("changeId", r.value().changeId());
                    ArrayNode stamps = ctx.putArray("stampIds");
                    r.value().stampIds().forEach(stamps::add);
                }
                putErrorCode(actual, r);
                return new Execution(actual);
            }
            case "start":
            case "complete":
            case "fail": {
                String rolloutId = when.path("release").path("rolloutId").asText();
                ExtensionResult<FireweaveClient.ReleaseStatus> r;
                if ("start".equals(op)) {
                    r = env.fwClient.releases().start(rolloutId);
                } else if ("complete".equals(op)) {
                    r = env.fwClient.releases().complete(rolloutId);
                } else {
                    r = env.fwClient.releases().fail(rolloutId, when.path("release").path("reason").asText(null));
                }
                ObjectNode actual = M.createObjectNode();
                actual.put("ok", r.isOk());
                if (r.isOk()) {
                    actual.put("status", r.value().status());
                    if (r.value().reason() != null) {
                        actual.put("reason", r.value().reason());
                    }
                }
                putErrorCode(actual, r);
                return new Execution(actual);
            }
            case "recordExposure": {
                Exposure exposure = parseExposure(when.path("exposure"));
                ExtensionResult<FireweaveClient.RecordOutcome> r = env.fwClient.exposures().record(exposure);
                ObjectNode actual = M.createObjectNode();
                actual.put("ok", r.isOk());
                if (r.isOk()) {
                    actual.put("queued", r.value().queued());
                    if (r.value().deduped()) {
                        actual.put("deduped", true);
                    }
                }
                putErrorCode(actual, r);
                return new Execution(actual);
            }
            case "flushExposures": {
                ExtensionResult<FireweaveClient.FlushOutcome> r = env.fwClient.exposures().flush();
                ObjectNode actual = M.createObjectNode();
                actual.put("ok", r.isOk());
                if (r.isOk()) {
                    actual.put("flushed", r.value().flushed());
                    actual.put("queued", r.value().queued());
                }
                putErrorCode(actual, r);
                return new Execution(actual);
            }
            case "emitSignal": {
                Signal signal = parseSignal(when.path("signal"));
                ExtensionResult<Signal> r = env.fwClient.signals().record(signal);
                ObjectNode actual = M.createObjectNode();
                actual.put("ok", r.isOk());
                actual.put("accepted", r.isOk());
                putErrorCode(actual, r);
                Execution exec = new Execution(actual);
                JsonNode forbidden = expect.get("recordedMessageMustNotContain");
                if (forbidden != null && forbidden.isArray()) {
                    for (Signal s : env.adapter.deliveredSignals()) {
                        String msg = s.message() == null ? "" : s.message();
                        for (JsonNode needle : forbidden) {
                            if (msg.contains(needle.asText())) {
                                exec.extraProblems.add("recorded signal message contains forbidden substring: "
                                        + needle.asText());
                            }
                        }
                    }
                }
                return exec;
            }
            case "getCapabilities": {
                Capabilities caps = env.fwClient.capabilities().get();
                ObjectNode actual = M.createObjectNode();
                ArrayNode names = actual.putArray("capabilities");
                caps.names().forEach(names::add);
                actual.putNull("errorCode");
                return new Execution(actual);
            }
            case "invokeCapability": {
                ExtensionResult<Object> r = env.fwClient.invokeCapability(
                        when.path("capability").asText(), new LinkedHashMap<>());
                ObjectNode actual = M.createObjectNode();
                actual.put("ok", r.isOk());
                if (r.error() != null) {
                    actual.put("errorCode", r.error().openFeatureErrorCode());
                    actual.put("errorMessage", r.error().message());
                    actual.put("errorKind", r.error().kind().name());
                }
                actual.put("degraded", r.isDegraded());
                return new Execution(actual);
            }
            default:
                throw new IllegalStateException("unknown operation: " + op);
        }
    }

    private Execution executeMultiDomain(JsonNode given, JsonNode when, JsonNode expect) throws Exception {
        Map<String, Env> envs = new LinkedHashMap<>();
        Iterator<Map.Entry<String, JsonNode>> it = given.get("domains").fields();
        while (it.hasNext()) {
            Map.Entry<String, JsonNode> e = it.next();
            Env env = buildEnv(e.getValue(), when, "-" + e.getKey());
            registerProvider(env, e.getValue());
            envs.put(e.getKey(), env);
        }
        Env target = envs.get(when.path("domain").asText());
        return doEvaluate(target, when, expect);
    }

    private Env buildEnv(JsonNode given, JsonNode when, String domainSuffix) {
        Env env = new Env();
        Map<String, FlagDefinition> flags = new LinkedHashMap<>();
        JsonNode flagsNode = given.get("flags");
        if (flagsNode != null && flagsNode.isObject()) {
            Iterator<Map.Entry<String, JsonNode>> it = flagsNode.fields();
            while (it.hasNext()) {
                Map.Entry<String, JsonNode> e = it.next();
                flags.put(e.getKey(), FlagDefinition.fromJson(e.getValue()));
            }
        }
        env.config = buildConfig(given.path("config"), given.get("globalContext"), when);
        env.adapter = new InMemoryAdapter(flags, FaultConfig.fromJson(given.get("fault")));
        env.runtime = new FireweaveRuntime(env.config, env.adapter);
        // NOT_READY means "runtime not yet initialized" — unless initialization IS the operation
        // under test, in which case the provider must drive it.
        boolean manual = "NOT_READY".equals(given.path("providerState").asText(""))
                && !"initialize".equals(when.path("operation").asText(""));
        env.provider = new FireweaveProvider(env.runtime,
                manual ? FireweaveProvider.InitMode.MANUAL : FireweaveProvider.InitMode.AUTOMATIC);
        env.fwClient = new FireweaveClient(env.runtime);
        env.domain = "conformance-" + (domainCounter++) + domainSuffix;
        return env;
    }

    private void registerProvider(Env env, JsonNode given) throws Exception {
        api.setProviderAndWait(env.domain, env.provider);
        env.ofClient = api.getClient(env.domain);

        String providerState = given.path("providerState").asText("READY");
        if ("CLOSED".equals(providerState)) {
            env.runtime.shutdown();
        } else if ("STALE".equals(providerState)) {
            env.adapter.setStale(true);
        }

        JsonNode clientCtx = given.get("clientContext");
        if (clientCtx != null) {
            env.ofClient.setEvaluationContext(toOfContext(clientCtx));
        }

        // Extension pre-state.
        JsonNode releaseCtx = given.get("releaseContext");
        if (releaseCtx != null) {
            env.fwClient.releases().setContext(parseReleaseContext(releaseCtx));
            if ("in_progress".equals(given.path("releaseStatus").asText(""))) {
                env.fwClient.releases().start(releaseCtx.path("rolloutId").asText());
            }
        }
        JsonNode queue = given.get("exposureQueue");
        if (queue != null && queue.isArray()) {
            for (JsonNode exp : queue) {
                env.fwClient.exposures().record(parseExposure(exp));
            }
        }
    }

    private FireweaveConfig buildConfig(JsonNode cfg, JsonNode globalContext, JsonNode when) {
        FireweaveConfig.Builder b = FireweaveConfig.builder();
        if (cfg.hasNonNull("projectApiKey")) {
            b.projectApiKey(cfg.get("projectApiKey").asText());
        }
        if (cfg.hasNonNull("host")) {
            b.host(cfg.get("host").asText());
        }
        if (cfg.has("allowedHosts")) {
            Set<String> hosts = new LinkedHashSet<>();
            cfg.get("allowedHosts").forEach(h -> hosts.add(h.asText()));
            b.allowedHosts(hosts);
        }
        b.requireTargetingKey(cfg.path("requireTargetingKey").asBoolean(false));
        if (cfg.has("reservedAttributeKeys")) {
            Set<String> keys = new LinkedHashSet<>();
            cfg.get("reservedAttributeKeys").forEach(k -> keys.add(k.asText()));
            b.reservedAttributeKeys(keys);
        }
        b.localEvaluation(cfg.path("localEvaluation").asBoolean(false));
        b.onlyEvaluateLocally(cfg.path("onlyEvaluateLocally").asBoolean(false));
        if (cfg.has("featureFlagsRequestTimeoutMs")) {
            b.requestTimeoutMs(cfg.get("featureFlagsRequestTimeoutMs").asInt());
        }
        JsonNode limits = cfg.get("limits");
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
            b.limits(lb.build());
        }
        if (globalContext != null) {
            b.globalContext(toFireweaveContext(globalContext));
        }
        if (when.path("options").path("includePayload").asBoolean(false)) {
            b.defaultEvaluationOptions(EvaluationOptions.builder().includePayloadMetadata(true).build());
        }
        return b.build();
    }

    // ------------------------------------------------------------------ evaluate

    private Execution doEvaluate(Env env, JsonNode when, JsonNode expect) throws Exception {
        String flagKey = when.path("flagKey").asText();
        String flagType = when.path("flagType").asText();
        JsonNode defaultValue = when.get("defaultValue");
        JsonNode invocation = when.path("invocationContext");

        // Reserved-attribute fixtures use attribute names the Java OF context cannot carry
        // distinctly from the targeting key ("targetingKey"); route those through the Fireweave
        // detailed API, which accepts arbitrary attribute names.
        boolean needsDirectPath = false;
        JsonNode attrs = invocation.get("attributes");
        if (attrs != null) {
            for (String reserved : env.config.reservedAttributeKeys()) {
                if (attrs.has(reserved) && "targetingKey".equals(reserved)) {
                    needsDirectPath = true;
                }
            }
        }

        ObjectNode actual;
        MutableContext callerCtx = null;
        if (needsDirectPath) {
            Decision d = env.fwClient.evaluate(flagKey, FlagType.fromCanonical(flagType),
                    Json.fromJackson(defaultValue), toFireweaveContext(invocation), null);
            actual = decisionToNode(d);
        } else {
            callerCtx = toOfContext(invocation);
            actual = ofEvaluate(env.ofClient, flagKey, flagType, defaultValue, callerCtx);
        }

        // Optional expected fields.
        if (expect.has("networkCalls")) {
            actual.put("networkCalls", env.adapter.evaluateCallCount());
        }
        if (expect.has("resolvedContext")) {
            JsonNode resolved = env.adapter.lastContext() == null
                    ? M.createObjectNode()
                    : Json.toJackson(env.adapter.lastContext().toJsonValue());
            actual.set("resolvedContext", FixtureComparator.project(resolved, expect.get("resolvedContext")));
        }
        if (expect.has("contextSnapshotAfter") && callerCtx != null) {
            ObjectNode snapshot = M.createObjectNode();
            if (callerCtx.getTargetingKey() != null) {
                snapshot.put("targetingKey", callerCtx.getTargetingKey());
            }
            ObjectNode snapAttrs = snapshot.putObject("attributes");
            for (Map.Entry<String, Value> e : callerCtx.asMap().entrySet()) {
                if (!"targetingKey".equals(e.getKey())) {
                    snapAttrs.set(e.getKey(), Json.toJackson(ofValueToJson(e.getValue())));
                }
            }
            actual.set("contextSnapshotAfter",
                    FixtureComparator.project(snapshot, expect.get("contextSnapshotAfter")));
        }

        Execution exec = new Execution(actual);
        if (needsDirectPath) {
            exec.note = "invoked via Fireweave detailed API: Java OF context cannot carry a literal "
                    + "'targetingKey' attribute distinct from the targeting key";
        }
        return exec;
    }

    private ObjectNode ofEvaluate(Client client, String flagKey, String flagType,
                                  JsonNode defaultValue, MutableContext ctx) throws Exception {
        FlagEvaluationDetails<?> details;
        JsonNode valueNode;
        switch (flagType) {
            case "boolean": {
                FlagEvaluationDetails<Boolean> d =
                        client.getBooleanDetails(flagKey, defaultValue.asBoolean(), ctx);
                details = d;
                valueNode = M.getNodeFactory().booleanNode(d.getValue());
                break;
            }
            case "string": {
                FlagEvaluationDetails<String> d =
                        client.getStringDetails(flagKey, defaultValue.asText(), ctx);
                details = d;
                valueNode = M.getNodeFactory().textNode(d.getValue());
                break;
            }
            case "integer": {
                FlagEvaluationDetails<Integer> d =
                        client.getIntegerDetails(flagKey, defaultValue.intValue(), ctx);
                details = d;
                valueNode = M.getNodeFactory().numberNode(d.getValue());
                break;
            }
            case "float": {
                FlagEvaluationDetails<Double> d =
                        client.getDoubleDetails(flagKey, defaultValue.doubleValue(), ctx);
                details = d;
                valueNode = M.getNodeFactory().numberNode(d.getValue());
                break;
            }
            case "object": {
                FlagEvaluationDetails<Value> d =
                        client.getObjectDetails(flagKey, nodeToOfValue(defaultValue), ctx);
                details = d;
                valueNode = Json.toJackson(ofValueToJson(d.getValue()));
                break;
            }
            default:
                throw new IllegalStateException("unknown flagType: " + flagType);
        }

        ObjectNode actual = M.createObjectNode();
        actual.set("value", valueNode);
        if (details.getVariant() != null) {
            actual.put("variant", details.getVariant());
        } else {
            actual.putNull("variant");
        }
        actual.put("reason", details.getReason());
        if (details.getErrorCode() != null) {
            actual.put("errorCode", details.getErrorCode().name());
        } else {
            actual.putNull("errorCode");
        }
        if (details.getErrorMessage() != null) {
            actual.put("errorMessage", details.getErrorMessage());
        } else {
            actual.putNull("errorMessage");
        }
        ObjectNode metadata = metadataToNode(details.getFlagMetadata());
        if (metadata.size() > 0) {
            actual.set("flagMetadata", metadata);
        }
        return actual;
    }

    private ObjectNode decisionToNode(Decision d) {
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
                putScalar(metadata, e.getKey(), e.getValue());
            }
        }
        return actual;
    }

    // ------------------------------------------------------------------ helpers

    private static void putErrorCode(ObjectNode actual, ExtensionResult<?> r) {
        if (r.error() != null) {
            actual.put("errorCode", r.error().openFeatureErrorCode());
        } else {
            actual.putNull("errorCode");
        }
    }

    private static String mapState(LifecycleState state) {
        switch (state) {
            case SHUTDOWN:
                return "CLOSED";
            case UNINITIALIZED:
            case INITIALIZING:
                return "NOT_READY";
            default:
                return state.name();
        }
    }

    private static ReleaseContext parseReleaseContext(JsonNode node) {
        ReleaseContext.Builder b = ReleaseContext.builder();
        node.path("stampIds").forEach(s -> b.stampId(s.asText()));
        if (node.hasNonNull("rolloutId")) {
            b.rolloutId(node.get("rolloutId").asText());
        }
        if (node.hasNonNull("changeId")) {
            b.changeId(node.get("changeId").asText());
        }
        return b.build();
    }

    private static Exposure parseExposure(JsonNode node) {
        return new Exposure(
                node.path("targetingKey").asText(),
                node.path("flagKey").asText(),
                node.hasNonNull("variant") ? node.get("variant").asText() : null,
                Json.fromJackson(node.get("value")),
                node.hasNonNull("rolloutId") ? node.get("rolloutId").asText() : null);
    }

    private static Signal parseSignal(JsonNode node) {
        Signal.Kind kind = Signal.Kind.valueOf(
                node.path("kind").asText().toUpperCase(java.util.Locale.ROOT));
        Signal.Builder b = Signal.builder(kind, node.path("name").asText());
        if (node.hasNonNull("status")) {
            b.status(node.get("status").asText());
        }
        if (node.hasNonNull("errorKind")) {
            b.errorKind(ErrorKind.valueOf(node.get("errorKind").asText()));
        }
        if (node.hasNonNull("message")) {
            b.message(node.get("message").asText());
        }
        if (node.has("value")) {
            b.value(Json.fromJackson(node.get("value")));
        }
        if (node.hasNonNull("targetingKey")) {
            b.targetingKey(node.get("targetingKey").asText());
        }
        if (node.hasNonNull("rolloutId")) {
            b.rolloutId(node.get("rolloutId").asText());
        }
        if (node.hasNonNull("changeId")) {
            b.changeId(node.get("changeId").asText());
        }
        if (node.hasNonNull("stampId")) {
            b.stampId(node.get("stampId").asText());
        }
        if (node.hasNonNull("flagKey")) {
            b.flagKey(node.get("flagKey").asText());
        }
        if (node.hasNonNull("variant")) {
            b.variant(node.get("variant").asText());
        }
        return b.build();
    }

    private static ai.fireweave.sdk.EvaluationContext toFireweaveContext(JsonNode ctxNode) {
        ai.fireweave.sdk.EvaluationContext.Builder b = ai.fireweave.sdk.EvaluationContext.builder();
        if (ctxNode.hasNonNull("targetingKey")) {
            b.targetingKey(ctxNode.get("targetingKey").asText());
        }
        JsonNode attrs = ctxNode.get("attributes");
        if (attrs != null && attrs.isObject()) {
            Iterator<Map.Entry<String, JsonNode>> it = attrs.fields();
            while (it.hasNext()) {
                Map.Entry<String, JsonNode> e = it.next();
                b.attribute(e.getKey(), Json.fromJackson(e.getValue()));
            }
        }
        return b.build();
    }

    private static MutableContext toOfContext(JsonNode ctxNode) {
        Map<String, Value> values = new LinkedHashMap<>();
        JsonNode attrs = ctxNode.get("attributes");
        if (attrs != null && attrs.isObject()) {
            Iterator<Map.Entry<String, JsonNode>> it = attrs.fields();
            while (it.hasNext()) {
                Map.Entry<String, JsonNode> e = it.next();
                values.put(e.getKey(), nodeToOfValue(e.getValue()));
            }
        }
        return ctxNode.hasNonNull("targetingKey")
                ? new MutableContext(ctxNode.get("targetingKey").asText(), values)
                : new MutableContext(values);
    }

    private static Value nodeToOfValue(JsonNode node) {
        if (node == null || node.isNull()) {
            return new Value();
        }
        if (node.isBoolean()) {
            return new Value(node.booleanValue());
        }
        if (node.isIntegralNumber()) {
            long l = node.longValue();
            if (l >= Integer.MIN_VALUE && l <= Integer.MAX_VALUE) {
                return new Value((int) l);
            }
            return new Value((double) l);
        }
        if (node.isNumber()) {
            return new Value(node.doubleValue());
        }
        if (node.isTextual()) {
            return new Value(node.textValue());
        }
        if (node.isArray()) {
            List<Value> items = new ArrayList<>(node.size());
            node.forEach(child -> items.add(nodeToOfValue(child)));
            return new Value(items);
        }
        Map<String, Value> fields = new LinkedHashMap<>();
        Iterator<Map.Entry<String, JsonNode>> it = node.fields();
        while (it.hasNext()) {
            Map.Entry<String, JsonNode> e = it.next();
            fields.put(e.getKey(), nodeToOfValue(e.getValue()));
        }
        return new Value(new dev.openfeature.sdk.ImmutableStructure(fields));
    }

    private static JsonValue ofValueToJson(Value v) {
        if (v == null || v.isNull()) {
            return JsonValue.ofNull();
        }
        if (v.isBoolean()) {
            return JsonValue.of(v.asBoolean());
        }
        if (v.isString()) {
            return JsonValue.of(v.asString());
        }
        if (v.isNumber()) {
            Double d = v.asDouble();
            Integer i = v.asInteger();
            if (i != null && d != null && i.doubleValue() == d) {
                return JsonValue.of(i);
            }
            return JsonValue.of(d);
        }
        if (v.isList()) {
            List<JsonValue> items = new ArrayList<>();
            for (Value item : v.asList()) {
                items.add(ofValueToJson(item));
            }
            return JsonValue.ofArray(items);
        }
        if (v.isStructure()) {
            Map<String, JsonValue> fields = new LinkedHashMap<>();
            for (Map.Entry<String, Value> e : v.asStructure().asMap().entrySet()) {
                fields.put(e.getKey(), ofValueToJson(e.getValue()));
            }
            return JsonValue.ofObject(fields);
        }
        return JsonValue.of(String.valueOf(v.asObject()));
    }

    @SuppressWarnings("unchecked")
    private static ObjectNode metadataToNode(ImmutableMetadata metadata) throws Exception {
        ObjectNode node = M.createObjectNode();
        if (metadata == null) {
            return node;
        }
        // ImmutableMetadata exposes only typed getters; enumerate via its backing map for the
        // normalized comparison (test-side only, never in SDK production code).
        Field f = ImmutableMetadata.class.getDeclaredField("metadata");
        f.setAccessible(true);
        Map<String, Object> map = (Map<String, Object>) f.get(metadata);
        for (Map.Entry<String, Object> e : map.entrySet()) {
            putScalar(node, e.getKey(), e.getValue());
        }
        return node;
    }

    private static void putScalar(ObjectNode node, String key, Object v) {
        if (v instanceof Boolean) {
            node.put(key, (Boolean) v);
        } else if (v instanceof Integer) {
            node.put(key, (Integer) v);
        } else if (v instanceof Long) {
            node.put(key, (Long) v);
        } else if (v instanceof Float) {
            node.put(key, (Float) v);
        } else if (v instanceof Double) {
            node.put(key, (Double) v);
        } else if (v != null) {
            node.put(key, v.toString());
        }
    }
}
