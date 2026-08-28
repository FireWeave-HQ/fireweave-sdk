package ai.fireweave.sdk;

import ai.fireweave.sdk.domain.ErrorKind;
import ai.fireweave.sdk.domain.FireweaveException;
import ai.fireweave.sdk.domain.Redaction;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.HashSet;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Validates ErrorKind against the canonical taxonomy in contracts/errors.json. */
class ErrorTaxonomyTest {

    static Path repoRoot() {
        Path p = Paths.get("").toAbsolutePath();
        while (p != null && !Files.exists(p.resolve("contracts").resolve("errors.json"))) {
            p = p.getParent();
        }
        assertNotNull(p, "repo root with contracts/errors.json not found");
        return p;
    }

    @Test
    void allFifteenKindsMatchContract() throws Exception {
        JsonNode doc = new ObjectMapper().readTree(
                repoRoot().resolve("contracts/errors.json").toFile());
        JsonNode errors = doc.get("errors");
        assertEquals(15, errors.size(), "contract declares 15 kinds");
        assertEquals(15, ErrorKind.values().length, "enum declares 15 kinds");

        Set<String> seen = new HashSet<>();
        for (JsonNode e : errors) {
            String kindName = e.get("kind").asText();
            ErrorKind kind = ErrorKind.valueOf(kindName); // throws if missing
            seen.add(kindName);
            assertEquals(e.get("openFeatureErrorCode").asText(), kind.openFeatureErrorCode(), kindName);
            assertEquals(e.get("retryable").asBoolean(), kind.retryable(), kindName);
            assertEquals(e.get("class").asText(), kind.failureClass().canonical(), kindName);
            assertEquals(e.get("defaultMessage").asText(), kind.defaultMessage(), kindName);
        }
        assertEquals(15, seen.size());
        assertEquals("fireweave.errorKind",
                doc.get("rules").get("flagMetadataErrorKindKey").asText());
        assertEquals("fireweave.errorKind", ErrorKind.FLAG_METADATA_ERROR_KIND_KEY);
    }

    @Test
    void alreadyClosedMapsToProviderNotReady() {
        assertEquals("PROVIDER_NOT_READY", ErrorKind.AlreadyClosed.openFeatureErrorCode());
    }

    @Test
    void causeIsPreservedAndMessageSanitized() {
        RuntimeException cause = new RuntimeException("boom phc_SECRETSECRET");
        FireweaveException e = new FireweaveException(ErrorKind.Network, "failed with key phc_SECRETSECRET", cause);
        assertTrue(e.getMessage().contains(Redaction.REDACTED));
        assertEquals(cause, e.getCause());
    }
}
