package ai.fireweave.sdk;

import org.junit.jupiter.api.Test;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

import javax.xml.parsers.DocumentBuilderFactory;
import java.io.File;
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
 * Layering guard (spec/control-points.md + spec/modes.md, "same layering" as the node/python
 * reference SDKs):
 *
 * <ul>
 *   <li>the SDK stays dependency-free — {@code fireweave-sdk/pom.xml}'s {@code <dependencies>}
 *       never carries a non-test-scoped entry;</li>
 *   <li>{@code domain/} stays pure — it imports nothing from {@code application/} or
 *       {@code infrastructure/}, so the same rules/types port to every target language's
 *       validation layer without dragging adapters or runtime wiring along;</li>
 *   <li>{@code application/} does not reach into {@code infrastructure/} except through the one
 *       sanctioned seam: {@code Fireweave.java}, the composition root (its whole job is adapter
 *       selection, so its concrete {@code infrastructure/adapters/*} imports are expected and
 *       exempt wholesale — mirrors node's {@code application/mode.ts} / python's
 *       {@code application/mode.py}).</li>
 * </ul>
 */
class ArchitectureLayersGuardTest {

    private static Path repoRoot() {
        Path p = Paths.get("").toAbsolutePath();
        while (p != null && !Files.exists(p.resolve("contracts").resolve("errors.json"))) {
            p = p.getParent();
        }
        assertNotNull(p, "repo root with contracts/errors.json not found");
        return p;
    }

    private static Path moduleRoot() {
        return repoRoot().resolve("sdks").resolve("java").resolve("fireweave-sdk");
    }

    private static Path domainDir() {
        return moduleRoot().resolve("src/main/java/ai/fireweave/sdk/domain");
    }

    private static Path applicationDir() {
        return moduleRoot().resolve("src/main/java/ai/fireweave/sdk/application");
    }

    /** Sanctioned composition root (mirrors node's mode.ts / python's mode.py). */
    private static final String APPLICATION_COMPOSITION_ROOT = "Fireweave.java";

    private static List<Path> javaFiles(Path dir) throws Exception {
        try (Stream<Path> walk = Files.walk(dir)) {
            return walk.filter(p -> p.toString().endsWith(".java")).collect(Collectors.toList());
        }
    }

    private static final Pattern IMPORT_PATTERN = Pattern.compile("^\\s*import\\s+(?:static\\s+)?([\\w.]+)\\s*;",
            Pattern.MULTILINE);

    private static List<String> importTargets(String source) {
        List<String> targets = new ArrayList<>();
        Matcher m = IMPORT_PATTERN.matcher(source);
        while (m.find()) {
            targets.add(m.group(1));
        }
        return targets;
    }

    /**
     * {@code [\w.]+} in {@link #IMPORT_PATTERN} does not match {@code *} — a wildcard import
     * ({@code import ai.fireweave.sdk.infrastructure.*;}) is therefore invisible to {@link
     * #importTargets}, so it would sneak a layering violation past {@link
     * #domainImportsNothingFromApplicationOrInfrastructure} / {@link
     * #applicationOutsideTheCompositionRootDoesNotImportInfrastructure} without either test ever
     * seeing it. Rather than teaching {@code IMPORT_PATTERN} to also resolve a wildcard's target
     * package (more regex surface for the same class of blind spot to hide in again), {@link
     * #noWildcardImportsInDomainOrApplication} forbids wildcard imports in {@code domain/} and
     * {@code application/} outright — simpler, and it closes the hole regardless of which
     * package a future wildcard import would have named.
     */
    private static final Pattern WILDCARD_IMPORT_PATTERN =
            Pattern.compile("^\\s*import\\s+(?:static\\s+)?[\\w.]+\\.\\*\\s*;", Pattern.MULTILINE);

    private static boolean hasWildcardImport(String source) {
        return WILDCARD_IMPORT_PATTERN.matcher(source).find();
    }

    @Test
    void domainImportsNothingFromApplicationOrInfrastructure() throws Exception {
        List<Path> files = javaFiles(domainDir());
        assertTrue(!files.isEmpty(), "expected source files under domain/");

        List<String> offenders = new ArrayList<>();
        for (Path file : files) {
            String text = new String(Files.readAllBytes(file));
            for (String target : importTargets(text)) {
                if (target.startsWith("ai.fireweave.sdk.application")
                        || target.startsWith("ai.fireweave.sdk.infrastructure")) {
                    offenders.add(domainDir().relativize(file) + " imports " + target);
                }
            }
        }
        assertEquals(List.of(), offenders, "domain/ must not depend on outer layers: " + offenders);
    }

    @Test
    void applicationOutsideTheCompositionRootDoesNotImportInfrastructure() throws Exception {
        List<Path> files = javaFiles(applicationDir());
        assertTrue(!files.isEmpty(), "expected source files under application/");

        List<String> offenders = new ArrayList<>();
        for (Path file : files) {
            if (file.getFileName().toString().equals(APPLICATION_COMPOSITION_ROOT)) {
                continue;
            }
            String text = new String(Files.readAllBytes(file));
            for (String target : importTargets(text)) {
                if (target.startsWith("ai.fireweave.sdk.infrastructure")) {
                    offenders.add(applicationDir().relativize(file) + " imports " + target);
                }
            }
        }
        assertEquals(List.of(), offenders,
                "application/ (outside " + APPLICATION_COMPOSITION_ROOT + ") must not import infrastructure/: "
                        + offenders);
    }

    /**
     * The flip side of the guard above: confirms the exemption is actually load-bearing
     * (Fireweave.java DOES import infrastructure/), not a dead carve-out for a boundary nothing
     * crosses.
     */
    @Test
    void compositionRootIsTheOnlyApplicationFileImportingInfrastructure() throws Exception {
        Path file = applicationDir().resolve(APPLICATION_COMPOSITION_ROOT);
        assertTrue(Files.exists(file), APPLICATION_COMPOSITION_ROOT + " must exist under application/");
        String text = new String(Files.readAllBytes(file));
        boolean importsInfrastructure = importTargets(text).stream()
                .anyMatch(t -> t.startsWith("ai.fireweave.sdk.infrastructure"));
        assertTrue(importsInfrastructure,
                APPLICATION_COMPOSITION_ROOT + " is exempted as the composition root but imports no "
                        + "infrastructure/ class — the exemption is stale");
    }

    /**
     * Wildcard imports are invisible to {@link #IMPORT_PATTERN} (see {@link
     * #WILDCARD_IMPORT_PATTERN}'s doc comment) — a {@code import ai.fireweave.sdk.infrastructure.*;}
     * in {@code domain/}, or in {@code application/} outside {@link
     * #APPLICATION_COMPOSITION_ROOT}, would silently pass both boundary tests above. Forbidding
     * wildcard imports outright in both directories (including the composition root itself, which
     * has no reason to obscure exactly which two adapter classes it selects) closes that hole
     * regardless of which package a future wildcard import would target.
     */
    @Test
    void noWildcardImportsInDomainOrApplication() throws Exception {
        List<String> offenders = new ArrayList<>();
        for (Path dir : List.of(domainDir(), applicationDir())) {
            for (Path file : javaFiles(dir)) {
                String text = new String(Files.readAllBytes(file));
                if (hasWildcardImport(text)) {
                    offenders.add(dir.relativize(file).toString());
                }
            }
        }
        assertEquals(List.of(), offenders,
                "wildcard imports are forbidden in domain/ and application/ — they defeat this guard's "
                        + "precise import-target matching: " + offenders);
    }

    @Test
    void pomDeclaresZeroNonTestRuntimeDependencies() throws Exception {
        File pomFile = moduleRoot().resolve("pom.xml").toFile();
        assertTrue(pomFile.exists(), "expected fireweave-sdk/pom.xml");
        Document doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(pomFile);
        Element root = doc.getDocumentElement();

        // Only the TOP-LEVEL <dependencies> (a direct child of <project>) declares actual
        // dependencies of this module; <dependencyManagement> merely pins versions for whatever
        // a future module chooses to depend on and carries no obligation of its own.
        NodeList children = root.getChildNodes();
        Element dependenciesEl = null;
        for (int i = 0; i < children.getLength(); i++) {
            org.w3c.dom.Node n = children.item(i);
            if (n instanceof Element && "dependencies".equals(n.getNodeName())) {
                dependenciesEl = (Element) n;
                break;
            }
        }
        assertNotNull(dependenciesEl, "expected a top-level <dependencies> section");

        List<String> nonTestDeps = new ArrayList<>();
        NodeList deps = dependenciesEl.getElementsByTagName("dependency");
        for (int i = 0; i < deps.getLength(); i++) {
            Element dep = (Element) deps.item(i);
            String scope = textOf(dep, "scope");
            String groupId = textOf(dep, "groupId");
            String artifactId = textOf(dep, "artifactId");
            if (!"test".equals(scope)) {
                nonTestDeps.add(groupId + ":" + artifactId + " (scope=" + scope + ")");
            }
        }
        assertEquals(List.of(), nonTestDeps,
                "fireweave-sdk must stay dependency-free at runtime — every <dependency> must be "
                        + "scope=test: " + nonTestDeps);
    }

    private static String textOf(Element parent, String tag) {
        NodeList nl = parent.getElementsByTagName(tag);
        return nl.getLength() == 0 ? null : nl.item(0).getTextContent().trim();
    }

    @Test
    void noTopLevelDeviationsExactlyThreeLayerPackages() throws Exception {
        // A fourth top-level package under ai.fireweave.sdk would be a layer in disguise
        // (mirrors the fw-server "no-top-level-deviations" idiom, ported to this module's
        // three-layer shape).
        Path srcRoot = moduleRoot().resolve("src/main/java/ai/fireweave/sdk");
        List<String> topLevelDirs;
        try (Stream<Path> entries = Files.list(srcRoot)) {
            topLevelDirs = entries.filter(Files::isDirectory)
                    .map(p -> p.getFileName().toString())
                    .sorted()
                    .collect(Collectors.toList());
        }
        assertEquals(List.of("application", "domain", "infrastructure"), topLevelDirs);
        // No stray .java files directly in the root package either (everything relayered).
        List<Path> looseFiles;
        try (Stream<Path> entries = Files.list(srcRoot)) {
            looseFiles = entries.filter(p -> p.toString().endsWith(".java")).collect(Collectors.toList());
        }
        assertTrue(looseFiles.isEmpty(), "no .java files should remain directly under ai.fireweave.sdk: "
                + looseFiles);
    }
}
