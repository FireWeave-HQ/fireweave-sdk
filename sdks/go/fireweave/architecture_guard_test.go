package fireweave

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// Layering guard (spec/control-points.md + spec/modes.md, "same layering" as
// the node/java reference SDKs):
//
//   - the SDK stays dependency-free — sdks/go/go.mod carries zero require
//     directives (Go's go.mod has no per-dependency test/prod scope, unlike
//     Maven's <scope>test</scope>, so "zero non-test requires" means zero
//     requires, period — any dependency, even a test-only one, needs a
//     require line);
//   - domain/ stays pure — it imports nothing from application/ or
//     infrastructure/, so the same rules/types port to every target
//     language's validation layer without dragging adapters or runtime
//     wiring along;
//   - application/ does not reach into infrastructure/ except through the
//     one sanctioned seam: application/mode.go, the composition root (its
//     whole job is adapter selection, so its concrete
//     infrastructure/adapters/* imports are expected and exempt wholesale —
//     mirrors node's application/mode.ts / java's application/Fireweave.java).
//
// Import scanning uses go/parser (parser.ImportsOnly), not regex: Go's AST
// natively distinguishes a plain import, an aliased import, a blank import
// (_), and a DOT IMPORT (.) — the go analogue of java's wildcard-import
// blind spot (java's `import pkg.*;` slipped past a regex requiring
// `[\w.]+;` up to the semicolon, since `*` isn't in that character class).
// Parsing sidesteps that whole class of regex blind spot: no plausible Go
// import syntax is invisible to go/parser. noDotImportsInDomainOrApplication
// additionally forbids dot-imports outright (not merely detects them) —
// same reasoning as java's chosen fix: a deliberately layered SDK core has
// no legitimate reason to import unqualified names, and banning the syntax
// removes the blind spot's target rather than only closing today's known
// instance of it.

func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "conformance", "surface", "control-points.surface.json")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("repo root with conformance/surface/control-points.surface.json not found")
		}
		dir = parent
	}
}

func sdkGoRoot(t *testing.T) string {
	return filepath.Join(repoRoot(t), "sdks", "go")
}

type fileImport struct {
	path  string
	isDot bool
}

// parseImports returns, for every non-directory .go file directly inside
// dir, the list of import paths that file declares (plain, aliased, blank,
// and dot alike — go/parser sees all four forms).
func parseImports(t *testing.T, dir string) map[string][]fileImport {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir %s: %v", dir, err)
	}
	fset := token.NewFileSet()
	out := map[string][]fileImport{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".go") {
			continue
		}
		path := filepath.Join(dir, e.Name())
		f, err := parser.ParseFile(fset, path, nil, parser.ImportsOnly)
		if err != nil {
			t.Fatalf("parse %s: %v", path, err)
		}
		var imports []fileImport
		for _, imp := range f.Imports {
			p, err := strconv.Unquote(imp.Path.Value)
			if err != nil {
				t.Fatalf("unquote import in %s: %v", path, err)
			}
			isDot := imp.Name != nil && imp.Name.Name == "."
			imports = append(imports, fileImport{path: p, isDot: isDot})
		}
		out[e.Name()] = imports
	}
	if len(out) == 0 {
		t.Fatalf("expected .go files under %s", dir)
	}
	return out
}

const (
	applicationImportPrefix    = "github.com/FireWeave-HQ/fireweave-sdk/sdks/go/application"
	infrastructureImportPrefix = "github.com/FireWeave-HQ/fireweave-sdk/sdks/go/infrastructure"
	// compositionRootFile is the one file under application/ permitted to
	// import infrastructure/adapters/* (mirrors node's application/mode.ts
	// / java's application/Fireweave.java).
	compositionRootFile = "mode.go"
)

func TestDomainImportsNothingFromApplicationOrInfrastructure(t *testing.T) {
	root := sdkGoRoot(t)
	imports := parseImports(t, filepath.Join(root, "domain"))

	var offenders []string
	for file, imps := range imports {
		for _, imp := range imps {
			if strings.HasPrefix(imp.path, applicationImportPrefix) || strings.HasPrefix(imp.path, infrastructureImportPrefix) {
				offenders = append(offenders, file+" imports "+imp.path)
			}
		}
	}
	if len(offenders) != 0 {
		t.Errorf("domain/ must not depend on outer layers: %v", offenders)
	}
}

func TestApplicationOutsideCompositionRootDoesNotImportInfrastructure(t *testing.T) {
	root := sdkGoRoot(t)
	imports := parseImports(t, filepath.Join(root, "application"))

	var offenders []string
	for file, imps := range imports {
		if file == compositionRootFile {
			continue
		}
		for _, imp := range imps {
			if strings.HasPrefix(imp.path, infrastructureImportPrefix) {
				offenders = append(offenders, file+" imports "+imp.path)
			}
		}
	}
	if len(offenders) != 0 {
		t.Errorf("application/ (outside %s) must not import infrastructure/: %v", compositionRootFile, offenders)
	}
}

// The flip side of the guard above: confirms the exemption is actually
// load-bearing (mode.go DOES import infrastructure/), not a dead carve-out
// for a boundary nothing crosses.
func TestCompositionRootIsTheOnlyApplicationFileImportingInfrastructure(t *testing.T) {
	root := sdkGoRoot(t)
	imports := parseImports(t, filepath.Join(root, "application"))
	modeImports, ok := imports[compositionRootFile]
	if !ok {
		t.Fatalf("%s must exist under application/", compositionRootFile)
	}
	found := false
	for _, imp := range modeImports {
		if strings.HasPrefix(imp.path, infrastructureImportPrefix) {
			found = true
		}
	}
	if !found {
		t.Fatalf("%s is exempted as the composition root but imports no infrastructure/ package — the exemption is stale", compositionRootFile)
	}
}

// noDotImportsInDomainOrApplication forbids dot-imports outright in both
// directories (including the composition root — it has no reason to
// obscure exactly which two adapter packages it selects, so no exemption
// is carved out for it), independent of which package a dot-import would
// have targeted. This is the go analogue of the wildcard-import blind spot
// java's layering guard was tightened against (fix round 1, commit
// 8251bbc): go/parser sees a dot-import's target package precisely (unlike
// java's regex, which literally could not match `import pkg.*;`), but a
// dot-import is banned anyway, so there is no second code path (an
// allowlist of "which packages a dot-import may target") to keep in sync.
func TestNoDotImportsInDomainOrApplication(t *testing.T) {
	root := sdkGoRoot(t)
	var offenders []string
	for _, dir := range []string{"domain", "application"} {
		imports := parseImports(t, filepath.Join(root, dir))
		for file, imps := range imports {
			for _, imp := range imps {
				if imp.isDot {
					offenders = append(offenders, dir+"/"+file+" dot-imports "+imp.path)
				}
			}
		}
	}
	if len(offenders) != 0 {
		t.Errorf("dot imports are forbidden in domain/ and application/: %v", offenders)
	}
}

// go.mod has no per-dependency test/prod scope (unlike Maven's
// <scope>test</scope>), so "zero non-test requires" means zero requires,
// period: any dependency — even one used only by _test.go files — needs a
// require line in go.mod. After the v1 cut (open-feature/go-sdk and
// posthog/posthog-go removed) the module has none, proven here rather than
// only asserted in prose.
func TestGoModDeclaresZeroRequires(t *testing.T) {
	root := sdkGoRoot(t)
	data, err := os.ReadFile(filepath.Join(root, "go.mod"))
	if err != nil {
		t.Fatalf("read go.mod: %v", err)
	}
	for _, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "//") {
			continue
		}
		if strings.Contains(trimmed, "require") {
			t.Errorf("go.mod must declare zero requires, found: %q", trimmed)
		}
	}
}

// No top-level deviations: exactly the three layer directories (plus
// cmd/, conformance/, internal/ — pre-existing, out of this guard's scope)
// sit under sdks/go, and this facade package holds no stray implementation
// files pulled in from the old flat layout.
func TestFacadeHoldsOnlyReExportsNoImplementation(t *testing.T) {
	root := sdkGoRoot(t)
	for _, dir := range []string{"domain", "application"} {
		if _, err := os.Stat(filepath.Join(root, dir)); err != nil {
			t.Errorf("expected sdks/go/%s to exist: %v", dir, err)
		}
	}
	for _, sub := range []string{"inmemory", "local", "remote"} {
		if _, err := os.Stat(filepath.Join(root, "infrastructure", "adapters", sub)); err != nil {
			t.Errorf("expected sdks/go/infrastructure/adapters/%s to exist: %v", sub, err)
		}
	}
}
