package ai.fireweave.sdk.start;

import ai.fireweave.sdk.domain.FireweaveException;
import ai.fireweave.sdk.domain.Mode;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The shared start-profile suite (contracts/start/, spec/start-profile.md) on Java: drives the
 * pure {@link StartResolver}, the instance-key derivation with an injected host name,
 * {@link Fw#defineFlags} and {@link BuildInfo#channelForVersion} with each case's inputs, compares
 * by the rules in contracts/start/README.md, and writes
 * {@code target/compatibility-report.start.java.json} (gitignored). Ported from node's reference
 * runner, sdks/node/test/unit/start-contracts.test.ts.
 */
class StartContractsTest {

    private static final String LANG = "java";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final JsonNodeFactory NODES = JsonNodeFactory.instance;

    /** Variable names a source may carry; anything else is an option (README "Comparing results"). */
    private static final Set<String> KNOWN_NAMES = new HashSet<>(Arrays.asList(
            "FIREWEAVE_KEY", "FIREWEAVE_URL", "FIREWEAVE_ENV", "APP_ENV",
            "FW_PROJECT_API_KEY", "FW_API_URL", "FW_ATTEST_URL"));

    private static List<JsonNode> fixtures;
    private static List<ObjectNode> results;

    /** The repository root: the first ancestor holding contracts/start. */
    static Path contractsDir() {
        Path p = Paths.get("").toAbsolutePath();
        while (p != null && !Files.exists(p.resolve("contracts").resolve("start").resolve("start-fixture.schema.json"))) {
            p = p.getParent();
        }
        assertNotNull(p, "repo root with contracts/start not found");
        return p.resolve("contracts").resolve("start");
    }

    @BeforeAll
    static void runSuite() throws IOException {
        Path dir = contractsDir();
        List<Path> files;
        try (Stream<Path> listing = Files.list(dir)) {
            files = listing
                    .filter(f -> f.getFileName().toString().endsWith(".json"))
                    .filter(f -> !f.getFileName().toString().equals("start-fixture.schema.json"))
                    .sorted()
                    .collect(Collectors.toList());
        }
        fixtures = new ArrayList<>();
        for (Path f : files) {
            fixtures.add(JSON.readTree(f.toFile()));
        }
        results = new ArrayList<>();
        for (JsonNode fx : fixtures) {
            results.add(runFixture(fx));
        }
        ObjectNode report = NODES.objectNode();
        report.put("language", LANG);
        report.put("suite", "start");
        ArrayNode rows = report.putArray("results");
        results.forEach(rows::add);
        String basedir = System.getProperty("basedir");
        Path module = basedir != null ? Paths.get(basedir) : Paths.get("").toAbsolutePath();
        Path out = module.resolve("target").resolve("compatibility-report.start.java.json");
        Files.createDirectories(out.getParent());
        Files.write(out, (JSON.writerWithDefaultPrettyPrinter().writeValueAsString(report) + "\n")
                .getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    @Test
    void contractsStartHasFixtures() {
        assertTrue(fixtures.size() >= 10, "expected the shared start-profile suite");
    }

    @TestFactory
    Stream<DynamicTest> everyFixtureDeclaredPassPasses() {
        List<DynamicTest> tests = new ArrayList<>();
        for (int i = 0; i < fixtures.size(); i++) {
            JsonNode fx = fixtures.get(i);
            if (!"pass".equals(fx.path("compatibility").path(LANG).asText())) {
                continue;
            }
            ObjectNode r = results.get(i);
            tests.add(DynamicTest.dynamicTest("contracts/start " + r.get("fixtureId").asText(),
                    () -> assertEquals("pass", r.get("status").asText(), r.get("message").asText())));
        }
        return tests.stream();
    }

    // ---------------------------------------------------------------- running a fixture

    private static ObjectNode runFixture(JsonNode fx) {
        ObjectNode row = NODES.objectNode();
        row.put("fixtureId", fx.get("id").asText());
        ArrayNode cases = NODES.arrayNode();
        if ("not-applicable".equals(fx.path("compatibility").path(LANG).asText())) {
            row.put("status", "not-applicable");
            row.set("cases", cases);
            row.put("message", "");
            return row;
        }
        List<String> failures = new ArrayList<>();
        for (JsonNode c : fx.get("cases")) {
            ObjectNode cr = cases.addObject();
            String name = c.get("name").asText();
            cr.put("name", name);
            if (c.has("appliesTo") && !contains(c.get("appliesTo"), LANG)) {
                cr.put("status", "not-applicable");
                continue;
            }
            List<String> diffs = compare(c.get("expect"), run(c.get("when")));
            if (diffs.isEmpty()) {
                cr.put("status", "pass");
            } else {
                String message = String.join("; ", diffs);
                cr.put("status", "fail");
                cr.put("message", message);
                failures.add(name + ": " + message);
            }
        }
        row.put("status", failures.isEmpty() ? "pass" : "fail");
        row.set("cases", cases);
        row.put("message", String.join(" | ", failures));
        return row;
    }

    private static boolean contains(JsonNode array, String value) {
        for (JsonNode n : array) {
            if (value.equals(n.asText())) {
                return true;
            }
        }
        return false;
    }

    /** What one case produced. */
    private static final class Outcome {
        final Map<String, JsonNode> fields = new LinkedHashMap<>();
        final List<String> warnings = new ArrayList<>();
        String errorKind;
        String errorMessage;
    }

    private static Outcome run(JsonNode when) {
        String operation = when.get("operation").asText();
        switch (operation) {
            case "resolve":
                return runResolve(when);
            case "instanceKey":
                return runInstanceKey(when);
            case "defineFlags":
                return runDefineFlags(when);
            case "channelForVersion":
                return runChannelForVersion(when);
            default:
                throw new IllegalStateException("operation " + operation + " is not applicable to " + LANG);
        }
    }

    private static Map<String, String> stringMap(JsonNode node) {
        Map<String, String> out = new HashMap<>();
        if (node == null || node.isNull()) {
            return out;
        }
        Iterator<Map.Entry<String, JsonNode>> it = node.fields();
        while (it.hasNext()) {
            Map.Entry<String, JsonNode> e = it.next();
            out.put(e.getKey(), e.getValue().asText());
        }
        return out;
    }

    private static Mode mode(String raw) {
        if (raw == null) {
            return null;
        }
        switch (raw) {
            case "local":
                return Mode.LOCAL;
            case "remote":
                return Mode.REMOTE;
            default:
                // Mode is an enum here: fixtures mark other spellings appliesTo the untyped SDKs.
                throw new IllegalStateException("mode '" + raw + "' is not representable in " + LANG);
        }
    }

    /** contracts/start/README.md "Comparing results": source names are normalised. */
    static String normaliseSource(String source) {
        if (source == null) {
            return null;
        }
        if ("none".equals(source)) {
            return "none";
        }
        if (source.startsWith("SDK channel")) {
            return "channel";
        }
        if (KNOWN_NAMES.contains(source)) {
            return source;
        }
        return "option";
    }

    private static JsonNode text(String value) {
        return value == null ? NODES.nullNode() : NODES.textNode(value);
    }

    private static Outcome runResolve(JsonNode when) {
        Map<String, String> options = stringMap(when.get("options"));
        Map<String, String> env = stringMap(when.get("env"));
        SdkChannel channel = "staging".equals(when.path("channel").asText("production"))
                ? SdkChannel.STAGING : SdkChannel.PRODUCTION;
        StartOptions opts = StartOptions.builder()
                .mode(mode(options.get("mode")))
                .environment(options.get("environment"))
                .url(options.get("url"))
                .key(options.get("key"))
                .build();
        Outcome out = new Outcome();
        try {
            StartResolver.Resolved r = StartResolver.resolve(opts, StartEnv.lookup(env::get, null),
                    "0.0.0-contract", channel);
            out.warnings.addAll(r.warnings);
            out.fields.put("mode", text(r.mode == null ? null : r.mode.name().toLowerCase(Locale.ROOT)));
            out.fields.put("modeSource", text(r.modeSource));
            out.fields.put("url", text(r.url));
            out.fields.put("urlSource", text(normaliseSource(r.urlSource)));
            if (r.allowedHosts == null) {
                out.fields.put("allowedHosts", NODES.nullNode());
            } else {
                ArrayNode hosts = NODES.arrayNode();
                r.allowedHosts.forEach(hosts::add);
                out.fields.put("allowedHosts", hosts);
            }
            out.fields.put("keySource", text(normaliseSource(r.keySource)));
            out.fields.put("environment", text(r.environment));
            out.fields.put("environmentSource", text(normaliseSource(r.environmentSource)));
        } catch (FireweaveException e) {
            out.errorKind = e.kind().name();
            out.errorMessage = e.getMessage();
        }
        return out;
    }

    private static Outcome runInstanceKey(JsonNode when) {
        Map<String, String> options = stringMap(when.get("options"));
        Map<String, String> env = stringMap(when.get("env"));
        JsonNode host = when.get("hostName");
        String hostName = host == null || host.isNull() ? null : host.asText();
        InstanceKeys.Derived key = InstanceKeys.derive(options.get("instanceId"), StartEnv.lookup(env::get, null),
                () -> hostName == null ? "" : hostName);
        Outcome out = new Outcome();
        out.fields.put("value", NODES.textNode(key.value));
        return out;
    }

    private static Outcome runDefineFlags(JsonNode when) {
        Map<String, Flag> flags = new LinkedHashMap<>();
        Iterator<Map.Entry<String, JsonNode>> it = when.get("flags").fields();
        while (it.hasNext()) {
            Map.Entry<String, JsonNode> e = it.next();
            JsonNode spec = e.getValue();
            boolean local = spec.get("local").booleanValue();
            flags.put(e.getKey(), spec.has("description")
                    ? Flag.local(local, spec.get("description").asText())
                    : Flag.local(local));
        }
        Outcome out = new Outcome();
        try {
            Fw.defineFlags(flags);
            out.fields.put("ok", NODES.booleanNode(true));
        } catch (FireweaveException e) {
            out.errorKind = e.kind().name();
            out.errorMessage = e.getMessage();
        }
        return out;
    }

    private static Outcome runChannelForVersion(JsonNode when) {
        Outcome out = new Outcome();
        out.fields.put("channel", NODES.textNode(BuildInfo.channelForVersion(when.get("version").asText()).toString()));
        return out;
    }

    // ---------------------------------------------------------------- comparing

    /** The differences between {@code expect} and the outcome; empty when the case passes. */
    private static List<String> compare(JsonNode expect, Outcome out) {
        List<String> diffs = new ArrayList<>();
        JsonNode err = expect.get("error");
        if (err != null) {
            String kind = err.get("kind").asText();
            if (out.errorKind == null) {
                diffs.add("expected a " + kind + " error, got " + out.fields);
                return diffs;
            }
            if (!out.errorKind.equals(kind)) {
                diffs.add("error kind " + out.errorKind + ", expected " + kind);
            }
            for (JsonNode n : err.path("mentions")) {
                if (!out.errorMessage.contains(n.asText())) {
                    diffs.add("error does not mention " + n.asText() + ": " + out.errorMessage);
                }
            }
            for (JsonNode n : err.path("mustNotMention")) {
                if (out.errorMessage.contains(n.asText())) {
                    diffs.add("error mentions " + n.asText());
                }
            }
            return diffs;
        }
        if (out.errorKind != null) {
            diffs.add("unexpected " + out.errorKind + " error: " + out.errorMessage);
            return diffs;
        }
        Iterator<Map.Entry<String, JsonNode>> it = expect.fields();
        while (it.hasNext()) {
            Map.Entry<String, JsonNode> e = it.next();
            String field = e.getKey();
            JsonNode want = e.getValue();
            if ("warnings".equals(field)) {
                for (JsonNode n : want.path("mention")) {
                    if (out.warnings.stream().noneMatch(l -> l.contains(n.asText()))) {
                        diffs.add("no warning mentions " + n.asText());
                    }
                }
                for (JsonNode n : want.path("mustNotMention")) {
                    if (out.warnings.stream().anyMatch(l -> l.contains(n.asText()))) {
                        diffs.add("a warning mentions " + n.asText());
                    }
                }
                continue;
            }
            if ("prefix".equals(field)) {
                String v = out.fields.containsKey("value") ? out.fields.get("value").asText() : "";
                if (!v.startsWith(want.asText())) {
                    diffs.add("value " + v + " does not start with " + want.asText());
                }
                continue;
            }
            JsonNode got = out.fields.getOrDefault(field, NODES.nullNode());
            if ("allowedHosts".equals(field) && want.isArray() && got.isArray()) {
                Set<String> a = new HashSet<>();
                want.forEach(n -> a.add(n.asText()));
                Set<String> b = new HashSet<>();
                got.forEach(n -> b.add(n.asText()));
                if (!a.equals(b)) {
                    diffs.add("allowedHosts " + got + ", expected " + want);
                }
                continue;
            }
            if (!got.equals(want)) {
                diffs.add(field + " " + got + ", expected " + want);
            }
        }
        return diffs;
    }
}
