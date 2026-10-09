package ai.fireweave.sdk;

import ai.fireweave.sdk.domain.Redaction;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RedactionTest {

    /**
     * Every vector in {@code contracts/errors.json} {@code rules.redaction} through the real
     * redactor (start-profile spec SP-26), plus the rule's placeholder and name list.
     */
    @Test
    void passesEveryContractRedactionVector() throws Exception {
        JsonNode rule = new ObjectMapper()
                .readTree(ErrorTaxonomyTest.repoRoot().resolve("contracts/errors.json").toFile())
                .get("rules").get("redaction");
        assertEquals(Redaction.REDACTED, rule.get("placeholder").asText());
        JsonNode vectors = rule.get("vectors");
        assertTrue(vectors.size() >= 16, "expected the contract's redaction vectors, got " + vectors.size());
        List<String> failures = new ArrayList<>();
        for (JsonNode v : vectors) {
            String in = v.get("in").asText();
            String want = v.get("out").asText();
            String got = Redaction.sanitize(in);
            if (!want.equals(got)) {
                failures.add(in + " -> " + got + " (want " + want + ")");
            }
            // Redaction is idempotent: a scrubbed line scrubs to itself.
            if (!got.equals(Redaction.sanitize(got))) {
                failures.add("not idempotent: " + got);
            }
            assertEquals(!in.equals(want), Redaction.containsSecret(in), in);
        }
        assertTrue(failures.isEmpty(), String.join("\n", failures));
        for (JsonNode name : rule.get("assignmentNames")) {
            String n = name.asText();
            assertEquals("set " + n + " first", Redaction.sanitize("set " + n + " first"), "a name alone stays");
            assertEquals(n + " = '" + Redaction.REDACTED + "'", Redaction.sanitize(n + " = 'v4lue'"));
        }
        for (JsonNode prefix : rule.get("valuePrefixes")) {
            String p = prefix.asText();
            assertEquals("k " + Redaction.REDACTED + ".", Redaction.sanitize("k " + p + "Ab-9_z."), p);
            assertEquals("k " + p + "\u2026", Redaction.sanitize("k " + p + "\u2026"), p);
        }
    }

    @Test
    void redactsProjectAndSecretKeys() {
        for (String prefix : new String[] {"phc_", "phs_", "phx_"}) {
            String out = Redaction.sanitize("auth failed for " + prefix + "ABC123xyz");
            assertFalse(out.contains(prefix), prefix);
            assertTrue(out.contains(Redaction.REDACTED));
        }
    }

    @Test
    void redactsBearerTokens() {
        String out = Redaction.sanitize("header Authorization: Bearer abc.def-ghi=");
        assertFalse(out.contains("abc.def"));
    }

    @Test
    void redactsProjectKeyEnvAssignments() {
        String out = Redaction.sanitize("FW_PROJECT_API_KEY=phc_TOPSECRET oops");
        assertFalse(out.contains("TOPSECRET"));
    }

    @Test
    void passesCleanMessagesThrough() {
        assertEquals("flag not found", Redaction.sanitize("flag not found"));
        assertNull(Redaction.sanitize(null));
    }

    @Test
    void containsSecretDetects() {
        assertTrue(Redaction.containsSecret("phs_abc"));
        assertFalse(Redaction.containsSecret("hello world"));
    }
}
