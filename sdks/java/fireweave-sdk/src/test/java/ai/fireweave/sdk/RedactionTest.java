package ai.fireweave.sdk;

import ai.fireweave.sdk.domain.Redaction;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RedactionTest {

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
