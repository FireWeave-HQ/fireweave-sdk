package ai.fireweave.sdk;

import ai.fireweave.sdk.application.FireweaveClient;
import ai.fireweave.sdk.application.FireweaveConfig;
import ai.fireweave.sdk.application.FireweaveRuntime;
import ai.fireweave.sdk.infrastructure.adapters.FireweaveLocalAdapter;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Control-point SURFACE parity (spec/control-points.md, conformance/surface/).
 *
 * <p>Behaviour is asserted elsewhere (ControlPointsTest, FireweaveRuntimeTest); this file asserts
 * the surface EXISTS. That distinction matters because a missing method is invisible: go shipped
 * {@code client.Flags()} with no ControlPoints namespace, and python shipped
 * {@code get_integer_value} with no object variant, both unnoticed for months, because nothing
 * structurally forced independent implementations to agree. This turns silent divergence into a
 * failing assertion — and pins the v1 scope boundary (mustNotExpose) at the same time.
 */
class ControlPointsSurfaceTest {

    private static Path repoRoot() {
        Path p = Paths.get("").toAbsolutePath();
        while (p != null && !Files.exists(p.resolve("conformance").resolve("surface")
                .resolve("control-points.surface.json"))) {
            p = p.getParent();
        }
        assertNotNull(p, "repo root with conformance/surface/control-points.surface.json not found");
        return p;
    }

    private static JsonNode descriptor() throws Exception {
        return new ObjectMapper().readTree(
                repoRoot().resolve("conformance").resolve("surface")
                        .resolve("control-points.surface.json").toFile());
    }

    private static FireweaveClient client() throws Exception {
        FireweaveRuntime runtime = new FireweaveRuntime(
                FireweaveConfig.builder().build(), new FireweaveLocalAdapter());
        runtime.initialize();
        return new FireweaveClient(runtime);
    }

    @Test
    void namespaceCasingIsControlPointsPerDescriptor() throws Exception {
        JsonNode namespace = descriptor().get("namespace");
        assertEquals("controlPoints", namespace.get("casing").get("java").asText());
        // The namespace exists under that exact name.
        assertNotNull(client().controlPoints());
    }

    @Test
    void controlPointsExposesAllNineMethodsAtDescriptorArity() throws Exception {
        JsonNode methods = descriptor().get("methods");
        assertTrue(methods.size() > 0, "expected methods in the surface descriptor");

        Object cp = client().controlPoints();
        Class<?> cpClass = cp.getClass();
        List<String> offenders = new ArrayList<>();
        for (JsonNode method : methods) {
            String name = method.get("name").asText();
            int expectedArity = method.get("args").size();
            List<Method> candidates = new ArrayList<>();
            for (Method m : cpClass.getMethods()) {
                if (m.getName().equals(name)) {
                    candidates.add(m);
                }
            }
            if (candidates.isEmpty()) {
                offenders.add(name + ": missing");
                continue;
            }
            boolean matched = candidates.stream().anyMatch(m -> m.getParameterCount() == expectedArity);
            if (!matched) {
                List<Integer> arities = new ArrayList<>();
                for (Method m : candidates) {
                    arities.add(m.getParameterCount());
                }
                offenders.add(name + ": expected arity " + expectedArity + " (" + method.get("args") + "), got "
                        + arities);
            }
        }
        assertEquals(List.of(), offenders, "arity mismatches: " + offenders);
    }

    @Test
    void theDeprecatedFlagsAliasSharesIdentityWithControlPoints() throws Exception {
        FireweaveClient fw = client();
        assertSame(fw.controlPoints(), fw.flags());
    }

    @Test
    void deprecatedAliasMatchesDescriptor() throws Exception {
        JsonNode namespace = descriptor().get("namespace");
        assertEquals("flags", namespace.get("deprecatedAlias").asText());
        assertTrue(namespace.get("aliasMustShareIdentity").asBoolean());
    }

    @Test
    void detailsReturnsADecisionValueReturnsTheBareValue() throws Exception {
        FireweaveClient fw = client();
        boolean value = fw.controlPoints().getBooleanValue("absent", false,
                ai.fireweave.sdk.domain.EvaluationContext.empty());
        ai.fireweave.sdk.domain.Decision details = fw.controlPoints().getBooleanDetails("absent", false,
                ai.fireweave.sdk.domain.EvaluationContext.empty());
        assertEquals(false, value);
        assertEquals(false, details.value().asBoolean());
        assertEquals("absent", details.flagKey());
        assertNotNull(details.reason());
    }

    @Test
    void registerTargetExistsWithLocalModeRecordedAndTraced() throws Exception {
        JsonNode clientMethods = descriptor().get("client").get("methods");
        JsonNode entry = null;
        for (JsonNode m : clientMethods) {
            if ("registerTarget".equals(m.get("name").asText())) {
                entry = m;
            }
        }
        assertNotNull(entry, "registerTarget must be declared under client.methods");
        assertEquals("recorded-and-traced", entry.get("localMode").asText());

        FireweaveClient fw = client();
        boolean hasRegisterTarget = false;
        for (Method m : FireweaveClient.class.getMethods()) {
            if (m.getName().equals("registerTarget")) {
                hasRegisterTarget = true;
            }
        }
        assertTrue(hasRegisterTarget);
        assertTrue(fw.registerTarget("user_1").ok(), "local mode registerTarget resolves ok:true");
    }

    @Test
    void mustNotExposeCutNamespacesAsMethodsOrFields() throws Exception {
        JsonNode mustNotExpose = descriptor().get("client").get("mustNotExpose");
        List<String> offenders = new ArrayList<>();
        for (JsonNode nameNode : mustNotExpose) {
            String name = nameNode.asText();
            // Cut PRODUCT namespaces (releases/exposures/signals/capabilities/guardrails):
            // neither a method nor a field of that name may exist on FireweaveClient.
            if (isProductNamespace(name)) {
                boolean hasMethod = java.util.Arrays.stream(FireweaveClient.class.getMethods())
                        .anyMatch(m -> m.getName().equalsIgnoreCase(name));
                boolean hasField = java.util.Arrays.stream(FireweaveClient.class.getFields())
                        .anyMatch(f -> f.getName().equalsIgnoreCase(name));
                if (hasMethod || hasField) {
                    offenders.add(name + " exposed on FireweaveClient");
                }
            } else {
                // Cut OpenFeature provider classes: must not exist anywhere on the classpath.
                String[] candidatePackages = {"ai.fireweave.sdk.", "ai.fireweave.sdk.application.",
                        "ai.fireweave.sdk.infrastructure.adapters."};
                for (String pkg : candidatePackages) {
                    try {
                        Class.forName(pkg + name);
                        offenders.add(name + " must not exist (found " + pkg + name + ")");
                    } catch (ClassNotFoundException expected) {
                        // good: it must not exist
                    }
                }
            }
        }
        assertEquals(List.of(), offenders, "v1 scope violations: " + offenders);
    }

    private static boolean isProductNamespace(String name) {
        return name.equals("releases") || name.equals("exposures") || name.equals("signals")
                || name.equals("capabilities") || name.equals("guardrails");
    }

    @Test
    void compatibilityCellIsGreenForJava() throws Exception {
        JsonNode compatibility = descriptor().get("compatibility");
        assertEquals("green", compatibility.get("java").asText());
    }

    @Test
    void mustNotExposeListMatchesTheFixedV1ScopeBoundary() throws Exception {
        // Locks the fixture's own contents so a future edit to the JSON is a deliberate,
        // reviewed decision rather than a silent scope-boundary change.
        List<String> expected = List.of("releases", "exposures", "signals", "capabilities",
                "guardrails", "FireweaveProvider", "FireweaveWebProvider");
        List<String> actual = new ArrayList<>();
        for (JsonNode n : descriptor().get("client").get("mustNotExpose")) {
            actual.add(n.asText());
        }
        assertEquals(expected, actual);
        assertFalse(actual.isEmpty());
    }
}
