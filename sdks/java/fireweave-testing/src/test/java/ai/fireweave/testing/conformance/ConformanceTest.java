package ai.fireweave.testing.conformance;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Runs all 65 contracts fixtures through the real OpenFeature client; fails on any mismatch. */
class ConformanceTest {

    @Test
    void allFixturesPassOrAreDeclaredSkips() throws Exception {
        Path contracts = findContracts();
        ConformanceRunner runner = new ConformanceRunner(contracts);
        ObjectMapper m = new ObjectMapper();

        int total = 0;
        int pass = 0;
        int skipped = 0;
        List<String> failures = new ArrayList<>();
        for (String suite : Arrays.asList(
                "evaluation", "context", "lifecycle", "faults", "security", "extensions")) {
            List<Path> files;
            try (Stream<Path> s = Files.list(contracts.resolve(suite))) {
                files = s.filter(p -> p.toString().endsWith(".json")).sorted().collect(Collectors.toList());
            }
            for (Path file : files) {
                JsonNode fixture = m.readTree(file.toFile());
                JsonNode row = runner.runFixture(fixture, suite);
                total++;
                String status = row.get("status").asText();
                if ("pass".equals(status)) {
                    pass++;
                } else if ("skipped-with-documented-limitation".equals(status)) {
                    skipped++;
                } else {
                    failures.add(row.get("fixtureId").asText() + ": " + row.path("message").asText());
                }
            }
        }
        assertEquals(65, total, "all 65 fixtures discovered (63 + ctx-fireweave-groups-carveout"
                + " + ext-lifecycle-gating)");
        assertTrue(failures.isEmpty(), "conformance failures:\n" + String.join("\n", failures));
        assertEquals(1, skipped, "only eval-int-beyond-safe-integer is a declared Java skip");
        assertEquals(64, pass);
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
