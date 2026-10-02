package ai.fireweave.sdk.start;

import ai.fireweave.sdk.domain.ErrorKind;
import ai.fireweave.sdk.domain.FireweaveException;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The channel rule, the build resource, flag validation and the instance-key derivation. */
class StartBuildingBlocksTest {

    // ---------------------------------------------------------------- channel

    @Test
    void theChannelRuleIsAPureFunctionOfTheVersion() {
        // tools/release/version.sh spells a Java staging release X.Y.Z-staging.N.
        assertEquals(SdkChannel.STAGING, BuildInfo.channelForVersion("2.4.0-staging.1"));
        assertEquals(SdkChannel.STAGING, BuildInfo.channelForVersion("2.4.0-staging.12"));
        assertEquals(SdkChannel.PRODUCTION, BuildInfo.channelForVersion("2.4.0"));
        assertEquals(SdkChannel.PRODUCTION, BuildInfo.channelForVersion("2.4.0-SNAPSHOT"));
        assertEquals(SdkChannel.PRODUCTION, BuildInfo.channelForVersion("2.4.0-staging"), "no iteration, no staging");
        assertEquals(SdkChannel.PRODUCTION, BuildInfo.channelForVersion("2.4.0a1"), "the PEP 440 form is python's");
        assertEquals(SdkChannel.PRODUCTION, BuildInfo.channelForVersion(BuildInfo.DEVEL_VERSION));
        assertEquals(SdkChannel.PRODUCTION, BuildInfo.channelForVersion(null));
        assertEquals("production", SdkChannel.PRODUCTION.toString());
        assertEquals("staging", SdkChannel.STAGING.toString());
    }

    private static InputStream props(String text) {
        return new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8));
    }

    @Test
    void aMissingOrUnfilteredResourceReadsAsDevel() {
        assertEquals(BuildInfo.DEVEL_VERSION, BuildInfo.versionFrom(null));
        assertEquals(BuildInfo.DEVEL_VERSION, BuildInfo.versionFrom(props("version=${project.version}\n")));
        assertEquals(BuildInfo.DEVEL_VERSION, BuildInfo.versionFrom(props("# nothing\n")));
        assertEquals("2.4.0-staging.3", BuildInfo.versionFrom(props("version= 2.4.0-staging.3 \n")));
    }

    @Test
    void theBuildFiltersThisModulesVersionIntoTheResource() {
        // Maven filtered build.properties when it copied it to target/classes.
        String version = Fw.sdkVersion();
        assertTrue(version.matches("\\d+\\.\\d+\\.\\d+.*"), version);
        assertFalse(version.contains("${"), version);
        assertEquals(BuildInfo.channelForVersion(version), Fw.sdkChannel());
    }

    // ---------------------------------------------------------------- flags

    @Test
    void defineFlagsValidatesWithTheCoreKeyRuleAndReturnsAnImmutableSortedCopy() {
        Map<String, Flag> input = new LinkedHashMap<>();
        input.put("zeta", Flag.local(false));
        input.put("new-checkout", Flag.local(true, "new checkout flow"));
        Flags flags = Fw.defineFlags(input);
        assertEquals(List.of("new-checkout", "zeta"), List.copyOf(flags.asMap().keySet()));
        assertTrue(flags.contains("new-checkout"));
        assertFalse(flags.contains("other"));
        assertEquals(2, flags.size());
        assertEquals("new checkout flow", flags.asMap().get("new-checkout").description());
        assertEquals(Map.of("new-checkout", true, "zeta", false), flags.localValues());
        input.put("late", Flag.local(true));
        assertEquals(2, flags.size(), "a copy, not a view");
        assertThrows(UnsupportedOperationException.class, () -> flags.asMap().put("x", Flag.local(true)));
        assertSame(Flags.none(), Fw.defineFlags(Map.of()));
    }

    @Test
    void defineFlagsRejectsBadKeysAsConfigurationErrors() {
        Map<String, Flag> nullKey = new HashMap<>();
        nullKey.put(null, Flag.local(true));
        Map<String, Flag> nullFlag = new HashMap<>();
        nullFlag.put("ok-key", null);
        Map<String, Flag> tooLong = Map.of("k".repeat(257), Flag.local(true));
        Map<String, Flag> control = Map.of("bad\u0007key", Flag.local(true));
        Map<String, Flag> empty = Map.of("", Flag.local(true));

        for (Map<String, Flag> bad : List.of(nullKey, nullFlag, tooLong, control, empty)) {
            FireweaveException e = assertThrows(FireweaveException.class, () -> Fw.defineFlags(bad));
            assertEquals(ErrorKind.Configuration, e.kind());
            assertTrue(e.getMessage().startsWith("flags: "), e.getMessage());
        }
        FireweaveException e = assertThrows(FireweaveException.class, () -> Fw.defineFlags(control));
        assertTrue(e.getMessage().contains("\"bad\\u0007key\""), "control characters are escaped: " + e.getMessage());
        assertThrows(FireweaveException.class, () -> Fw.defineFlags(null));
    }

    @Test
    void theFlagsSignatureCoversKeysAndLocalValuesOnly() {
        Flags a = Fw.defineFlags(Map.of("a", Flag.local(true, "one")));
        Flags b = Fw.defineFlags(Map.of("a", Flag.local(true, "two")));
        Flags c = Fw.defineFlags(Map.of("a", Flag.local(false)));
        assertEquals(a.signature(), b.signature());
        assertNotEquals(a.signature(), c.signature());
    }

    // ---------------------------------------------------------------- instance key

    @Test
    void fnv1a64MatchesTheReferenceVectors() {
        assertEquals("cbf29ce484222325", InstanceKeys.fnv1a64(""));
        assertEquals("af63dc4c8601ec8c", InstanceKeys.fnv1a64("a"));
    }

    /**
     * One host gives one instance key in every SDK. The expected values were computed with node's
     * {@code fnv1a64} (sdks/node/src/start/instance.ts) and Go's {@code hash/fnv} New64a, the
     * function sdks/go/fw/instance.go uses, on 2026-10-02.
     */
    @Test
    void theHostHashEqualsWhatNodeAndGoDerive() {
        assertEquals("8148fc8bb0e952ef", InstanceKeys.fnv1a64("api-pod-1"));
        assertEquals("1e183a27e4e4c211", InstanceKeys.fnv1a64("ip-10-0-0-12.ec2.internal"));
        assertEquals("7cf801ffb8f0c725", InstanceKeys.fnv1a64("hôte-ü"), "hashed as UTF-8 bytes");
        InstanceKeys.Derived d = InstanceKeys.derive(null, name -> "", () -> "api-pod-1");
        assertEquals("inst_8148fc8bb0e952ef", d.value);
        assertEquals(InstanceKeys.SOURCE_HOST, d.source);
    }

    @Test
    void instanceKeyOrderIsOptionThenVariableThenHostThenRandom() {
        Map<String, String> withId = Map.of("FIREWEAVE_INSTANCE_ID", " worker-7 ", "HOSTNAME", "from-env");
        Map<String, String> withHostname = Map.of("HOSTNAME", "api-pod-1");

        InstanceKeys.Derived option = InstanceKeys.derive(" cron-1 ", StartEnv.lookup(withId::get, null), () -> "os");
        assertEquals("cron-1", option.value);
        assertEquals(InstanceKeys.SOURCE_OPTION, option.source);

        InstanceKeys.Derived env = InstanceKeys.derive("  ", StartEnv.lookup(withId::get, null), () -> "os");
        assertEquals("worker-7", env.value);
        assertEquals("FIREWEAVE_INSTANCE_ID", env.source);

        InstanceKeys.Derived hostVar = InstanceKeys.derive(null, StartEnv.lookup(withHostname::get, null), () -> "os");
        assertEquals("inst_8148fc8bb0e952ef", hostVar.value, "HOSTNAME is read before the operating system");

        InstanceKeys.Derived os = InstanceKeys.derive(null, name -> "", () -> " api-pod-1 ");
        assertEquals("inst_8148fc8bb0e952ef", os.value);

        InstanceKeys.Derived r1 = InstanceKeys.derive(null, name -> "", () -> "");
        InstanceKeys.Derived r2 = InstanceKeys.derive(null, name -> "", () -> "");
        assertEquals(InstanceKeys.SOURCE_RANDOM, r1.source);
        assertTrue(r1.value.matches("^inst_[0-9a-f]{32}$"), r1.value);
        assertNotEquals(r1.value, r2.value);
    }
}
