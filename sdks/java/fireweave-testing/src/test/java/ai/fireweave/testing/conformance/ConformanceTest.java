package ai.fireweave.testing.conformance;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

import java.io.IOException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.fail;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Runs every contracts/ fixture through {@link ConformanceRunner} as JUnit 5 dynamic tests
 * (contracts/harness.md — the java analogue of node's test/conformance suite, go's
 * conformance/harness_test.go, python's test_conformance.py).
 *
 * <p>Previously there was no fixture-driven conformance entry for java at all — the old
 * {@code fireweave-testing} module (ConformanceRunner + ConformanceTest against the OpenFeature
 * client) was deleted alongside the v1 cut (commit 43bb492) and never rebuilt. This class is
 * that rebuild, against the v1 control-points surface.
 */
class ConformanceTest {

    private static final Path CONTRACTS_DIR =
            Paths.get("..", "..", "..", "contracts").toAbsolutePath().normalize();

    /**
     * Known, out-of-scope gaps (see task-10-report.md "Concerns" for the original writeup and
     * task-10b-report.md for what since got fixed). Each is a genuine divergence between the
     * frozen fixture's declared {@code compatibility.java: "pass"} and actual SDK behavior — not
     * a runner bug. These are assumption-skipped here (not silently — the reason is printed in
     * the surefire report), rather than left failing the whole build. {@link ConformanceRunner}'s
     * own report (compatibility-report.java.json, written by {@code main()}) still carries their
     * TRUE "fail" status.
     *
     * <p>Note eval-int-beyond-safe-integer needs no entry here: that fixture's
     * {@code compatibility.java} is itself declared {@code skipped-with-documented-limitation}
     * (java's Long-via-double getNumberValue path, same as node), so
     * {@link ConformanceRunner#runFixture} handles it via the ordinary declared-skip path.
     *
     * <p>task-10b fixed ctx-reserved-keys-rejected (FireweaveRuntime now bakes
     * {@code Validation.DEFAULT_RESERVED_ATTRIBUTE_KEYS} into its constructor unconditionally,
     * merged with caller-supplied keys), flipped eval-numeric-coercion-int-float's
     * {@code compatibility.java} to the genuinely-declared skipped-with-documented-limitation
     * (controller-ruled fixture edit), and implemented eval-payload-attached
     * ({@code ai.fireweave.sdk.application.EvaluationOptions#includePayload()}, threaded through
     * both {@code InMemoryAdapter} and {@code FireweaveRemoteAdapter}) — all three removed below;
     * {@code KNOWN_GAPS} is now empty.
     */
    private static final Map<String, String> KNOWN_GAPS = new HashMap<>();

    @TestFactory
    Stream<DynamicTest> conformanceFixtures() throws IOException {
        List<JsonNode> fixtures = ConformanceRunner.loadFixtures(CONTRACTS_DIR);
        assertEquals(65, fixtures.size(), "expected 65 fixtures, found " + fixtures.size());
        return fixtures.stream().map(fixture -> {
            String id = fixture.get("id").asText();
            String name = fixture.get("suite").asText() + "/" + id;
            return DynamicTest.dynamicTest(name, () -> {
                JsonNode row = ConformanceRunner.runFixture(fixture);
                String status = row.get("status").asText();
                String reason = KNOWN_GAPS.get(id);
                if (reason != null && "fail".equals(status)) {
                    assumeTrue(false, "known gap (Task 10 scope limits): " + reason);
                    return;
                }
                if ("skipped-with-documented-limitation".equals(status) || "skipped-v1-out-of-scope".equals(status)) {
                    JsonNode limitation = row.get("limitation");
                    assumeTrue(false, status + ": "
                            + (limitation != null && !limitation.isNull() ? limitation.asText() : ""));
                    return;
                }
                if ("fail".equals(status)) {
                    JsonNode message = row.get("message");
                    fail(id + ": " + (message != null && !message.isNull() ? message.asText() : ""));
                }
            });
        });
    }
}
