package ai.fireweave.sdk;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Start-profile confinement (docs/adr/0012-start-profile.md; the Java counterpart of node's
 * architecture-layers test and Go's architecture_guard_test.go):
 *
 * <ul>
 *   <li>the core reads no environment and no host name (spec/modes.md); the start profile reads
 *       them through ONE seam class, {@code start/StartEnv.java}, and nowhere else in this module;</li>
 *   <li>{@code start/} is built only on the core's public {@code application/} and {@code domain/}
 *       types and {@code java.*} — never {@code infrastructure/};</li>
 *   <li>no core package imports or names {@code start/}, so the core never depends on the layer
 *       over it;</li>
 *   <li>{@code start/} registers no JVM shutdown hook and writes no files (nothing is written to
 *       disk, ADR-0012 rule 6).</li>
 * </ul>
 *
 * <p>Scans are scoped to this module's {@code src/main}, with comments and string literals
 * stripped so prose that NAMES an API (this very Javadoc, the core's "reads no environment"
 * notes) is not a violation. fireweave-testing's ConformanceRunner legitimately binds a loopback
 * socket via {@code InetAddress} and is out of scope.
 */
class StartConfinementGuardTest {

    private static Path repoRoot() {
        Path p = Paths.get("").toAbsolutePath();
        while (p != null && !Files.exists(p.resolve("contracts").resolve("errors.json"))) {
            p = p.getParent();
        }
        assertNotNull(p, "repo root with contracts/errors.json not found");
        return p;
    }

    private static Path sourceRoot() {
        return repoRoot().resolve("sdks/java/fireweave-sdk/src/main/java/ai/fireweave/sdk");
    }

    private static final String START_PACKAGE = "ai.fireweave.sdk.start";
    private static final String START_DIR = "start";
    /** The one file allowed to read the environment or the host name. */
    private static final String ENV_SEAM = "start/StartEnv.java";

    /** Environment, system-property and host-name reads, as they appear in code. */
    private static final List<Pattern> ENV_OR_HOST_READS = List.of(
            Pattern.compile("\\bSystem\\s*\\.\\s*getenv\\b"),
            Pattern.compile("\\bSystem\\s*\\.\\s*getProperty\\b"),
            Pattern.compile("\\bSystem\\s*\\.\\s*getProperties\\b"),
            Pattern.compile("\\bInetAddress\\b"),
            Pattern.compile("\\bgetLocalHost\\b"),
            Pattern.compile("\\bProcessHandle\\b"));

    /** Host-name sources spelled as string literals (matched with strings kept). */
    private static final List<Pattern> HOST_NAME_LITERALS = List.of(
            Pattern.compile("kernel/hostname"),
            Pattern.compile("/etc/hostname"));

    /** Things the start profile must never do: hook JVM exit, or write to disk. */
    private static final List<Pattern> START_FORBIDDEN = List.of(
            Pattern.compile("\\baddShutdownHook\\b"),
            Pattern.compile("\\bFiles\\s*\\.\\s*(write|writeString|newOutputStream|newBufferedWriter|createFile|"
                    + "createDirectories|createDirectory|createTempFile|copy|move|delete|deleteIfExists)\\b"),
            Pattern.compile("\\b(FileOutputStream|FileWriter|RandomAccessFile|PrintWriter)\\b"));

    private static final Pattern IMPORT_PATTERN =
            Pattern.compile("^\\s*import\\s+(?:static\\s+)?([\\w.]+)\\s*;", Pattern.MULTILINE);

    /** A source file's path relative to {@link #sourceRoot()} (forward slashes) and its code. */
    private static final class Source {
        final String rel;
        final String code;
        final String codeWithStrings;

        Source(String rel, String raw) {
            this.rel = rel;
            this.code = strip(raw, true);
            this.codeWithStrings = strip(raw, false);
        }

        boolean inStart() {
            return rel.startsWith(START_DIR + "/");
        }
    }

    private static List<Source> sources() throws Exception {
        Path root = sourceRoot();
        List<Path> files;
        try (Stream<Path> walk = Files.walk(root)) {
            files = walk.filter(p -> p.toString().endsWith(".java")).sorted().collect(Collectors.toList());
        }
        List<Source> out = new ArrayList<>();
        for (Path f : files) {
            String rel = root.relativize(f).toString().replace('\\', '/');
            out.add(new Source(rel, new String(Files.readAllBytes(f), StandardCharsets.UTF_8)));
        }
        assertTrue(out.size() > 20, "expected the module's sources under " + root);
        assertTrue(out.stream().anyMatch(Source::inStart), "expected the start profile under " + root + "/start");
        return out;
    }

    /**
     * Blanks comments and the contents of string, text-block and char literals, keeping line
     * structure. Not a full lexer, but exact for the code in this module (no unicode escapes of
     * quotes).
     */
    static String stripCommentsAndStrings(String src) {
        return strip(src, true);
    }

    private static String strip(String src, boolean blankStrings) {
        StringBuilder out = new StringBuilder(src.length());
        int i = 0;
        int n = src.length();
        while (i < n) {
            char c = src.charAt(i);
            char next = i + 1 < n ? src.charAt(i + 1) : '\0';
            if (c == '/' && next == '/') {
                while (i < n && src.charAt(i) != '\n') {
                    i++;
                }
            } else if (c == '/' && next == '*') {
                i += 2;
                while (i < n && !(src.charAt(i) == '*' && i + 1 < n && src.charAt(i + 1) == '/')) {
                    if (src.charAt(i) == '\n') {
                        out.append('\n');
                    }
                    i++;
                }
                i += 2;
            } else if (c == '"' || c == '\'') {
                char quote = c;
                int start = i;
                i++;
                while (i < n && src.charAt(i) != quote) {
                    if (src.charAt(i) == '\\') {
                        i++;
                    }
                    i++;
                }
                i++;
                if (blankStrings) {
                    out.append(quote).append(quote);
                } else {
                    out.append(src, start, Math.min(i, n));
                }
            } else {
                out.append(c);
                i++;
            }
        }
        return out.toString();
    }

    private static List<String> matches(String rel, String text, List<Pattern> patterns) {
        List<String> found = new ArrayList<>();
        for (Pattern p : patterns) {
            Matcher m = p.matcher(text);
            while (m.find()) {
                found.add(rel + ": " + m.group());
            }
        }
        return found;
    }

    @Test
    void onlyTheSeamReadsTheEnvironmentOrTheHostName() throws Exception {
        List<String> offenders = new ArrayList<>();
        for (Source s : sources()) {
            if (s.rel.equals(ENV_SEAM)) {
                continue;
            }
            offenders.addAll(matches(s.rel, s.code, ENV_OR_HOST_READS));
            offenders.addAll(matches(s.rel, s.codeWithStrings, HOST_NAME_LITERALS));
        }
        assertEquals(List.of(), offenders,
                "only " + ENV_SEAM + " may read the environment, system properties or the host name (the core "
                        + "reads none, spec/modes.md; the start profile reads through one seam, ADR-0012)");
    }

    /** The flip side: the exemption is load-bearing, not a dead carve-out. */
    @Test
    void theSeamStillDoesTheReadsItIsExemptedFor() throws Exception {
        Source seam = sources().stream().filter(s -> s.rel.equals(ENV_SEAM)).findFirst().orElse(null);
        assertNotNull(seam, ENV_SEAM + " must exist: it is the start profile's env seam");
        for (String want : List.of("System.getenv", "InetAddress", "kernel/hostname")) {
            assertTrue(seam.codeWithStrings.contains(want), ENV_SEAM + " no longer calls " + want + "; update the guard with the seam");
        }
    }

    @Test
    void startImportsOnlyThePublicCoreAndJava() throws Exception {
        List<String> offenders = new ArrayList<>();
        for (Source s : sources()) {
            if (!s.inStart()) {
                continue;
            }
            Matcher m = IMPORT_PATTERN.matcher(s.code);
            while (m.find()) {
                String target = m.group(1);
                boolean allowed = target.startsWith("java.")
                        || target.startsWith("ai.fireweave.sdk.application.")
                        || target.startsWith("ai.fireweave.sdk.domain.")
                        || target.startsWith(START_PACKAGE + ".");
                if (!allowed) {
                    offenders.add(s.rel + " imports " + target);
                }
            }
            // A fully-qualified reference would bypass the import check.
            if (s.code.contains("ai.fireweave.sdk.infrastructure")) {
                offenders.add(s.rel + " names ai.fireweave.sdk.infrastructure");
            }
        }
        assertEquals(List.of(), offenders,
                "start/ may use only the core's public application/ and domain/ types and java.*: " + offenders);
    }

    @Test
    void noCorePackageDependsOnStart() throws Exception {
        List<String> offenders = new ArrayList<>();
        for (Source s : sources()) {
            if (!s.inStart() && s.code.contains(START_PACKAGE)) {
                offenders.add(s.rel);
            }
        }
        assertEquals(List.of(), offenders,
                "the core must not depend on the start profile layered over it: " + offenders);
    }

    @Test
    void startRegistersNoShutdownHookAndWritesNoFiles() throws Exception {
        List<String> offenders = new ArrayList<>();
        for (Source s : sources()) {
            if (s.inStart()) {
                offenders.addAll(matches(s.rel, s.code, START_FORBIDDEN));
            }
        }
        assertEquals(List.of(), offenders,
                "start/ registers no JVM shutdown hook and writes nothing to disk (ADR-0012): " + offenders);
    }

    @Test
    void theStripperKeepsCodeAndDropsProse() {
        String src = "String u = \"https://x\"; // System.getenv in a comment\n"
                + "/* InetAddress */ int a = 1; char q = '\"'; System.getenv(\"K\");\n";
        String code = stripCommentsAndStrings(src);
        assertTrue(code.contains("System.getenv("), code);
        assertTrue(!code.contains("InetAddress") && !code.contains("https"), code);
    }
}
