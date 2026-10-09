package ai.fireweave.sdk.start;

import ai.fireweave.sdk.domain.ErrorKind;
import ai.fireweave.sdk.domain.FireweaveException;
import ai.fireweave.sdk.domain.Mode;
import ai.fireweave.sdk.domain.Redaction;
import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The start profile's resolution table (ADR-0012 rules 1–4), through the pure resolver alone:
 * precedence, the mode rule, the endpoint and its allowlist, and the key-family check.
 */
class StartResolverTest {

    private static final String KEY = "project-api-key_resolver-secret";

    private static Map<String, String> env(String... kv) {
        Map<String, String> m = new HashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            m.put(kv[i], kv[i + 1]);
        }
        return m;
    }

    private static StartResolver.Resolved resolve(StartOptions opts, Map<String, String> env) {
        return resolve(opts, env, SdkChannel.PRODUCTION);
    }

    private static StartResolver.Resolved resolve(StartOptions opts, Map<String, String> env, SdkChannel channel) {
        return StartResolver.resolve(opts, StartEnv.lookup(env::get, null), "2.4.0", channel);
    }

    private static FireweaveException fails(StartOptions opts, Map<String, String> env) {
        FireweaveException e = assertThrows(FireweaveException.class, () -> resolve(opts, env));
        assertEquals(ErrorKind.Configuration, e.kind());
        // Every message survives redaction unchanged and never carries a key.
        assertEquals(Redaction.sanitize(e.getMessage()), e.getMessage());
        assertFalse(Redaction.containsSecret(e.getMessage()), e.getMessage());
        assertFalse(e.getMessage().contains(KEY), e.getMessage());
        return e;
    }

    private static StartOptions.Builder opts() {
        return StartOptions.builder();
    }

    // ---------------------------------------------------------------- key → remote

    @Test
    void aKeyFromTheEnvironmentMeansRemoteAgainstTheChannelHost() {
        StartResolver.Resolved r = resolve(StartOptions.defaults(), env("FIREWEAVE_KEY", KEY));
        assertEquals(Mode.REMOTE, r.mode);
        assertEquals("key", r.modeSource);
        assertEquals(KEY, r.key);
        assertEquals("FIREWEAVE_KEY", r.keySource);
        assertEquals("https://app-server.fireweave.ai", r.url);
        assertEquals("SDK channel (production)", r.urlSource);
        assertNull(r.allowedHosts, "the default endpoint uses the core's default allowlist");
        assertTrue(r.warnings.isEmpty());
    }

    @Test
    void theKeyOptionWinsOverTheEnvironment() {
        StartResolver.Resolved r = resolve(opts().key(KEY).build(), env("FIREWEAVE_KEY", "project-api-key_other"));
        assertEquals(KEY, r.key);
        assertEquals("StartOptions.key", r.keySource);
    }

    @Test
    void theLegacyKeyNameIsReadWithOneWarningNamingItsReplacement() {
        StartResolver.Resolved r = resolve(StartOptions.defaults(), env("FW_PROJECT_API_KEY", KEY));
        assertEquals(Mode.REMOTE, r.mode);
        assertEquals("FW_PROJECT_API_KEY", r.keySource);
        assertEquals(1, r.warnings.size());
        assertTrue(r.warnings.get(0).contains("FW_PROJECT_API_KEY is a legacy name"), r.warnings.get(0));
        assertTrue(r.warnings.get(0).contains("Rename it to FIREWEAVE_KEY"), r.warnings.get(0));
        assertEquals(Redaction.sanitize(r.warnings.get(0)), r.warnings.get(0));
    }

    @Test
    void theNewKeyNameWinsOverTheLegacyOneWithoutAWarning() {
        StartResolver.Resolved r = resolve(StartOptions.defaults(),
                env("FIREWEAVE_KEY", KEY, "FW_PROJECT_API_KEY", "project-api-key_legacy"));
        assertEquals(KEY, r.key);
        assertTrue(r.warnings.isEmpty());
    }

    @Test
    void emptyAndWhitespaceValuesCountAsUnsetOptionsIncluded() {
        StartResolver.Resolved r = resolve(opts().key("   ").environment(" ").build(),
                env("FIREWEAVE_KEY", "", "FW_PROJECT_API_KEY", " \t", "FIREWEAVE_ENV", "  ", "APP_ENV", " test "));
        assertEquals(Mode.LOCAL, r.mode);
        assertEquals("APP_ENV", r.environmentSource);
        assertEquals("test", r.environment);
    }

    // ---------------------------------------------------------------- no key → environment rule

    @Test
    void noKeyAndADevelopmentEnvironmentMeansLocal() {
        for (String name : Arrays.asList("development", "dev", "local", "test", " Development ", "TEST")) {
            StartResolver.Resolved r = resolve(StartOptions.defaults(), env("FIREWEAVE_ENV", name));
            assertEquals(Mode.LOCAL, r.mode, name);
            assertEquals("environment", r.modeSource);
            assertEquals("FIREWEAVE_ENV", r.environmentSource);
            assertEquals("none", r.keySource);
            assertNull(r.url);
        }
    }

    @Test
    void appEnvIsTheFallbackAfterFireweaveEnv() {
        StartResolver.Resolved r = resolve(StartOptions.defaults(), env("APP_ENV", "dev"));
        assertEquals(Mode.LOCAL, r.mode);
        assertEquals("APP_ENV", r.environmentSource);

        // FIREWEAVE_ENV is read first, so a production FIREWEAVE_ENV is not overridden by APP_ENV.
        FireweaveException e = fails(StartOptions.defaults(), env("FIREWEAVE_ENV", "production", "APP_ENV", "dev"));
        assertTrue(e.getMessage().contains("\"production\" (from FIREWEAVE_ENV)"), e.getMessage());
    }

    @Test
    void theEnvironmentOptionWinsOverTheVariables() {
        StartResolver.Resolved r = resolve(opts().environment("local").build(), env("FIREWEAVE_ENV", "production"));
        assertEquals(Mode.LOCAL, r.mode);
        assertEquals("StartOptions.environment", r.environmentSource);

        FireweaveException e = fails(opts().environment("prod").build(), env("FIREWEAVE_ENV", "development"));
        assertTrue(e.getMessage().contains("\"prod\" (from StartOptions.environment)"), e.getMessage());
    }

    @Test
    void noKeyAndNoEnvironmentFailsClosedNamingFireweaveKeyAndWhereItLooked() {
        FireweaveException e = fails(StartOptions.defaults(), env());
        assertTrue(e.getMessage().startsWith("FIREWEAVE_KEY is not set and no environment name is set"), e.getMessage());
        assertTrue(e.getMessage().contains("checked StartOptions.environment, FIREWEAVE_ENV and APP_ENV"), e.getMessage());
        assertFalse(e.getMessage().contains("FW_ENV is no longer read"), e.getMessage());
    }

    @Test
    void noKeyAndAProductionEnvironmentFailsClosed() {
        FireweaveException e = fails(StartOptions.defaults(), env("APP_ENV", "staging"));
        assertTrue(e.getMessage().contains("the environment is \"staging\" (from APP_ENV), which is not a development name"),
                e.getMessage());
    }

    @Test
    void anEnvironmentValueThatLooksLikeAKeyIsNeverEchoed() {
        FireweaveException e = fails(StartOptions.defaults(), env("FIREWEAVE_ENV", KEY));
        assertTrue(e.getMessage().contains("the environment name from FIREWEAVE_ENV is not a development name"),
                e.getMessage());
    }

    @Test
    void fwEnvIsNotReadButIsMentionedInTheError() {
        FireweaveException e = fails(StartOptions.defaults(), env("FW_ENV", "development"));
        assertTrue(e.getMessage().contains("FW_ENV is no longer read; rename it to FIREWEAVE_ENV."), e.getMessage());
    }

    @Test
    void nodeEnvIsNotAJavaConvention() {
        fails(StartOptions.defaults(), env("NODE_ENV", "development"));
    }

    // ---------------------------------------------------------------- explicit mode

    @Test
    void explicitLocalWinsAndIgnoresAKeyWithOneWarning() {
        StartResolver.Resolved r = resolve(opts().mode(Mode.LOCAL).build(),
                env("FIREWEAVE_KEY", KEY, "FIREWEAVE_ENV", "production"));
        assertEquals(Mode.LOCAL, r.mode);
        assertEquals("option", r.modeSource);
        assertNull(r.key);
        assertEquals("none", r.keySource);
        assertEquals(1, r.warnings.size());
        assertTrue(r.warnings.get(0).contains("ignores the key from FIREWEAVE_KEY"), r.warnings.get(0));
        assertFalse(r.warnings.get(0).contains(KEY));
    }

    @Test
    void explicitLocalWithoutAKeyNeedsNoEnvironmentAndWarnsNothing() {
        StartResolver.Resolved r = resolve(opts().mode(Mode.LOCAL).build(), env());
        assertEquals(Mode.LOCAL, r.mode);
        assertTrue(r.warnings.isEmpty());
    }

    @Test
    void explicitRemoteWithoutAKeyIsAConfigurationError() {
        FireweaveException e = fails(opts().mode(Mode.REMOTE).build(), env("FIREWEAVE_ENV", "development"));
        assertTrue(e.getMessage().contains("needs a key. Set FIREWEAVE_KEY"), e.getMessage());
    }

    @Test
    void explicitRemoteWithAKeyRecordsTheOptionAsTheReason() {
        StartResolver.Resolved r = resolve(opts().mode(Mode.REMOTE).build(),
                env("FIREWEAVE_KEY", KEY, "FIREWEAVE_ENV", "development"));
        assertEquals(Mode.REMOTE, r.mode);
        assertEquals("option", r.modeSource);
    }

    @Test
    void aKeyWinsOverADevelopmentEnvironment() {
        StartResolver.Resolved r = resolve(StartOptions.defaults(), env("FIREWEAVE_KEY", KEY, "FIREWEAVE_ENV", "test"));
        assertEquals(Mode.REMOTE, r.mode);
        assertNull(r.environment, "the environment name is consulted only without a key");
    }

    // ---------------------------------------------------------------- endpoint

    @Test
    void aStagingBuildDefaultsToTheStagingHost() {
        StartResolver.Resolved r = resolve(StartOptions.defaults(), env("FIREWEAVE_KEY", KEY), SdkChannel.STAGING);
        assertEquals("https://staging-app-server.fireweave.ai", r.url);
        assertEquals("SDK channel (staging)", r.urlSource);
        assertNull(r.allowedHosts);
    }

    @Test
    void anOverriddenUrlAllowsItsHostPlusLoopback() {
        StartResolver.Resolved r = resolve(StartOptions.defaults(),
                env("FIREWEAVE_KEY", KEY, "FIREWEAVE_URL", "https://FW.Example.com/"));
        assertEquals("https://FW.Example.com", r.url, "trailing slashes are stripped");
        assertEquals("FIREWEAVE_URL", r.urlSource);
        assertEquals(List.of("fw.example.com", "localhost", "127.0.0.1", "::1"), r.allowedHosts);
    }

    @Test
    void theUrlOptionWinsThenFireweaveUrlThenTheLegacyNamesInOrder() {
        Map<String, String> all = env("FIREWEAVE_KEY", KEY, "FIREWEAVE_URL", "https://a.example.com",
                "FW_API_URL", "https://b.example.com", "FW_ATTEST_URL", "https://c.example.com");
        assertEquals("StartOptions.url", resolve(opts().url("https://o.example.com").build(), all).urlSource);
        assertEquals("FIREWEAVE_URL", resolve(StartOptions.defaults(), all).urlSource);

        StartResolver.Resolved legacy = resolve(StartOptions.defaults(),
                env("FIREWEAVE_KEY", KEY, "FW_API_URL", "https://b.example.com", "FW_ATTEST_URL", "https://c.example.com"));
        assertEquals("FW_API_URL", legacy.urlSource);
        assertEquals(1, legacy.warnings.size());
        assertTrue(legacy.warnings.get(0).contains("Rename it to FIREWEAVE_URL"), legacy.warnings.get(0));

        StartResolver.Resolved attest = resolve(StartOptions.defaults(),
                env("FIREWEAVE_KEY", KEY, "FW_ATTEST_URL", "https://c.example.com"));
        assertEquals("FW_ATTEST_URL", attest.urlSource);
    }

    @Test
    void plainHttpIsAllowedOnlyOnLoopback() {
        for (String url : Arrays.asList("http://localhost:3000", "http://127.0.0.1:8080", "http://[::1]:8080")) {
            StartResolver.Resolved r = resolve(opts().url(url).build(), env("FIREWEAVE_KEY", KEY));
            assertEquals(Mode.REMOTE, r.mode, url);
            assertEquals(3, r.allowedHosts.size(), url + ": loopback is not listed twice");
        }
        FireweaveException e = fails(StartOptions.defaults(),
                env("FIREWEAVE_KEY", KEY, "FIREWEAVE_URL", "http://fw.example.com"));
        assertTrue(e.getMessage().contains("The endpoint from FIREWEAVE_URL must use https"), e.getMessage());
    }

    @Test
    void invalidEndpointsNameTheirSourceNeverTheValue() {
        for (String bad : Arrays.asList("not a url", "ftp://fw.example.com", "https://", "fw.example.com")) {
            FireweaveException e = fails(StartOptions.defaults(), env("FIREWEAVE_KEY", KEY, "FW_API_URL", bad));
            assertTrue(e.getMessage().contains("The endpoint from FW_API_URL is not a valid URL."), bad + ": " + e.getMessage());
        }
        for (String bad : Arrays.asList("https://user:pw@fw.example.com", "https://fw.example.com?x=1",
                "https://fw.example.com#frag")) {
            FireweaveException e = fails(opts().url(bad).build(), env("FIREWEAVE_KEY", KEY));
            assertTrue(e.getMessage().contains("The endpoint from StartOptions.url must not carry credentials"),
                    bad + ": " + e.getMessage());
            assertFalse(e.getMessage().contains("pw@"), e.getMessage());
        }
    }

    @Test
    void anEndpointIsIgnoredInLocalMode() {
        StartResolver.Resolved r = resolve(StartOptions.defaults(),
                env("FIREWEAVE_ENV", "dev", "FIREWEAVE_URL", "http://not-checked.example.com"));
        assertEquals(Mode.LOCAL, r.mode);
        assertNull(r.url);
    }

    // ---------------------------------------------------------------- key families

    @Test
    void browserVendorOrgAndCliKeysAreRejectedNamingTheSourceNeverTheValue() {
        Object[][] rows = {
                {"fw_public_abc123", "is a browser key"},
                {"phq_abc123", "is an analytics vendor key"},
                {"fw_org_abc123", "is an organisation or CLI token"},
                {"cli_at_abc123", "is an organisation or CLI token"},
        };
        for (Object[] row : rows) {
            String value = (String) row[0];
            FireweaveException e = fails(StartOptions.defaults(), env("FIREWEAVE_KEY", value));
            assertTrue(e.getMessage().contains("The key from FIREWEAVE_KEY " + row[1]), value + ": " + e.getMessage());
            assertFalse(e.getMessage().contains(value), "the value is never echoed: " + e.getMessage());

            FireweaveException legacy = fails(StartOptions.defaults(), env("FW_PROJECT_API_KEY", value));
            assertTrue(legacy.getMessage().contains("The key from FW_PROJECT_API_KEY " + row[1]), legacy.getMessage());

            FireweaveException option = fails(opts().key(value).build(), env());
            assertTrue(option.getMessage().contains("The key from StartOptions.key " + row[1]), option.getMessage());
        }
    }

    @Test
    void theKeyFamilyIsCheckedBeforeTheEndpoint() {
        FireweaveException e = fails(StartOptions.defaults(),
                env("FIREWEAVE_KEY", "fw_public_abc", "FIREWEAVE_URL", "http://fw.example.com"));
        assertTrue(e.getMessage().contains("browser key"), e.getMessage());
    }

    @Test
    void projectKeysAreAccepted() {
        assertNull(StartResolver.checkKeyFamily("project-api-key_abc", "FIREWEAVE_KEY"));
        assertNull(StartResolver.checkKeyFamily("fw_ingest_pub_abc", "FIREWEAVE_KEY"), "legacy project key family");
    }

    @Test
    void flagsPassThroughToTheDecision() {
        LocalControlPoints controlPoints = Fw.defineControlPoints(Map.of("a", LocalControlPoint.local(true)));
        assertEquals(controlPoints, resolve(opts().controlPoints(controlPoints).build(), env("FIREWEAVE_ENV", "dev")).controlPoints);
    }
}
