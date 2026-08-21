#!/usr/bin/env node
/**
 * Fireweave cross-language conformance comparator (contracts/README.md +
 * contracts/harness.md "compatibility-report-aggregate").
 *
 * Loads every fixture under contracts/{evaluation,context,lifecycle,faults,
 * security,extensions}/ and the four per-language compatibility reports, then
 * enforces the "CI: fail on silent divergence" rules:
 *
 *   1. Any report row with status "fail"                          -> FAIL
 *   2. Report status != fixture-declared compatibility.<lang>
 *      (undeclared divergence / silent status drift) for
 *      node/python/go/java — EXCEPT the ruled v1-scope carve-out
 *      below                                                       -> FAIL
 *   3. Missing fixture x language cell in a report                -> FAIL
 *   4. Report row for an unknown fixture id                        -> FAIL
 *   5. skipped-with-documented-limitation without limitation text
 *      (in fixture or report)                                     -> FAIL
 *   6. Duplicate fixture ids / missing compatibility entries      -> FAIL
 *
 * The matrix is 65 fixtures x 7 languages (contracts/harness.md ruling 3):
 *   - node / python / go / java: loaded from --report <lang>=<path>, each
 *     one of the four SDK conformance runners actually executed.
 *   - web: SYNTHESIZED, not loaded — ADR-0009 gave web its own
 *     contracts/web/ suite instead of the shared 65 (the shared fixtures
 *     encode async server semantics a synchronous cache-read surface can't
 *     answer), so every one of the 65 reports `not-applicable-web` here;
 *     web's real signal is sdks/web/test/conformance/run.ts's own
 *     compatibility-report.web.json against contracts/web/*, tracked
 *     outside this matrix.
 *   - rust / swift: SYNTHESIZED as `not-implemented` — no SDK exists yet
 *     (Phase 6).
 * contracts/README.md's field-rules table requires compatibility.<lang> only
 * for node/python/go/java; web/rust/swift carry no per-fixture declaration,
 * so rule 2 and the "missing compatibility.<lang>" fixture check apply only
 * to the first four.
 *
 * Extensions v1-scope carve-out (contracts/harness.md ruling 2): 13 of the
 * 14 contracts/extensions/*.json fixtures declare `compatibility.<lang> =
 * "pass"` from before ADR-0010's v1 cut but target a namespace (releases/
 * exposures/signals/capabilities) no longer exposed by any language. Each
 * runner reports these `skipped-v1-out-of-scope` instead of executing them —
 * an EXPECTED, ruled divergence from the frozen "pass" declaration, not an
 * undeclared one, so rule 2 does not fire for this specific combination.
 *
 * All four languages emit the one contracts/README.md compatibility-report
 * schema: { schemaVersion, results: [{fixtureId, suite, language, status,
 * limitation, message}], summary }. (Prior to Task 10, python wrote a
 * different ad hoc shape — { language, total, passed, failed, skipped,
 * results: [{id, ...}] } — that dialect no longer exists anywhere and this
 * comparator no longer accommodates it.)
 *
 * Usage:
 *   node tools/conformance/compare.mjs \
 *     --contracts contracts \
 *     --report node=path.json --report python=path.json \
 *     --report go=path.json --report java=path.json \
 *     --out build/conformance/compatibility-report.json \
 *     [--markdown build/conformance/summary.md] \
 *     [--web-report sdks/web/test/conformance/compatibility-report.web.json]
 *
 * `--web-report` (task-10b item 6, optional) surfaces web's OWN separate
 * contracts/web/ suite (sdks/web/test/conformance/run.ts, ADR-0009 — 10
 * fixtures the shared 65x7 matrix does not and should not cover, see the
 * `web` bullet above) as a supplementary, informational-only section: it
 * does not change the 65x7 matrix, does not add to `divergences`, and does
 * not affect this tool's exit code — web's suite is gated independently by
 * the "web" CI job's own `bun run conformance`.
 *
 * Zero dependencies; Node >= 20. Exit code 0 = no divergence, 1 = divergence,
 * 2 = usage / IO error.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

// Languages with a real conformance runner: --report <lang>=<path> is
// required for each, and contracts/README.md requires compatibility.<lang>
// declared on every fixture.
const DECLARED_LANGUAGES = ['node', 'python', 'go', 'java'];
// Synthesized columns (contracts/harness.md ruling 3): no --report file, no
// per-fixture compatibility.<lang> declaration — computed for all 65.
const SYNTHESIZED_LANGUAGES = ['web', 'rust', 'swift'];
const LANGUAGES = [...DECLARED_LANGUAGES, ...SYNTHESIZED_LANGUAGES];
const SUITES = ['evaluation', 'context', 'lifecycle', 'faults', 'security', 'extensions'];
const STATUSES = new Set([
  'pass',
  'fail',
  'skipped-with-documented-limitation',
  'skipped-v1-out-of-scope',
  'not-applicable-web',
  'not-implemented',
]);

function usageError(msg) {
  process.stderr.write(`compare: ${msg}\n`);
  process.exit(2);
}

// ---------- argument parsing ----------

function parseArgs(argv) {
  const args = { contracts: 'contracts', reports: {}, out: null, markdown: null, webReport: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) usageError(`missing value for ${a}`);
      return argv[i];
    };
    if (a === '--contracts') args.contracts = next();
    else if (a === '--out') args.out = next();
    else if (a === '--markdown') args.markdown = next();
    // --web-report is OPTIONAL and purely informational (task-10b item 6):
    // web's own contracts/web/ suite (sdks/web/test/conformance/run.ts) is a
    // separate 10-fixture suite with its own gate (the "web" CI job runs
    // `bun run conformance` and fails independently) — it is NOT one of the
    // synthesized 65 `not-applicable-web` cells above and does not change
    // this comparator's required inputs, matrix, or exit code. When passed,
    // its counts are surfaced as a supplementary section so a reader of this
    // report sees both signals in one place without this tool re-deriving or
    // re-gating on web's own pass/fail (that stays sdks/web's job).
    else if (a === '--web-report') args.webReport = next();
    else if (a === '--report') {
      const v = next();
      const eq = v.indexOf('=');
      if (eq < 1) usageError(`--report expects <lang>=<path>, got "${v}"`);
      const lang = v.slice(0, eq);
      if (!DECLARED_LANGUAGES.includes(lang)) {
        usageError(
          `unknown language "${lang}" for --report (only ${DECLARED_LANGUAGES.join(', ')} load a ` +
            `report file — web/rust/swift are synthesized, not loaded)`,
        );
      }
      args.reports[lang] = v.slice(eq + 1);
    } else usageError(`unknown argument "${a}"`);
  }
  return args;
}

// ---------- optional web-suite supplementary section (informational only) ----------

/**
 * Loads sdks/web/test/conformance/compatibility-report.web.json (or an
 * equivalent path) if --web-report was given. Never affects `violations` or
 * the exit code — web's own suite gates itself (the "web" CI job). Tolerant
 * of a missing/unparseable file: reports a warning row rather than crashing
 * the whole comparator over an optional, purely-informational input.
 */
function loadWebSuite(path) {
  if (!path) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const results = Array.isArray(raw.results) ? raw.results : [];
    const pass = results.filter((r) => r.status === 'pass').length;
    const fail = results.filter((r) => r.status === 'fail').length;
    return { path, fixtureCount: results.length, pass, fail, ok: fail === 0 && results.length > 0 };
  } catch (err) {
    return { path, error: err.message, ok: false };
  }
}

// ---------- fixture loading ----------

function loadFixtures(contractsDir) {
  const fixtures = new Map(); // id -> fixture
  const problems = [];
  for (const suite of SUITES) {
    let entries;
    try {
      entries = readdirSync(join(contractsDir, suite));
    } catch {
      problems.push(`missing suite directory: ${suite}/`);
      continue;
    }
    for (const name of entries.filter((n) => n.endsWith('.json')).sort()) {
      const path = join(contractsDir, suite, name);
      let fixture;
      try {
        fixture = JSON.parse(readFileSync(path, 'utf8'));
      } catch (err) {
        problems.push(`${suite}/${name}: unparseable JSON (${err.message})`);
        continue;
      }
      const id = fixture.id;
      if (!id) {
        problems.push(`${suite}/${name}: fixture has no id`);
        continue;
      }
      if (id !== basename(name, '.json')) {
        problems.push(`${suite}/${name}: id "${id}" does not match filename`);
      }
      if (fixtures.has(id)) {
        problems.push(`duplicate fixture id "${id}" (${suite}/${name})`);
        continue;
      }
      const compat = fixture.compatibility ?? {};
      // Only node/python/go/java carry a per-fixture declaration
      // (contracts/README.md field-rules table); web/rust/swift are
      // synthesized aggregate-only columns.
      for (const lang of DECLARED_LANGUAGES) {
        const declared = compat[lang];
        if (declared === undefined) {
          problems.push(`${id}: missing compatibility.${lang}`);
        } else if (!STATUSES.has(declared)) {
          problems.push(`${id}: invalid compatibility.${lang} "${declared}"`);
        } else if (
          declared === 'skipped-with-documented-limitation' &&
          !(typeof (fixture.limitations ?? {})[lang] === 'string' && fixture.limitations[lang].trim())
        ) {
          problems.push(`${id}: compatibility.${lang} is skipped but limitations.${lang} is empty`);
        }
      }
      fixtures.set(id, fixture);
    }
  }
  return { fixtures, problems };
}

// ---------- report loading / normalization ----------

function loadReport(lang, path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const rows = new Map(); // fixtureId -> normalized row
  const problems = [];
  const list = Array.isArray(raw.results) ? raw.results : null;
  if (!list) {
    problems.push(`${lang}: report ${path} has no "results" array`);
    return { rows, problems };
  }
  for (const r of list) {
    const fixtureId = r.fixtureId;
    if (!fixtureId) {
      problems.push(`${lang}: report row without fixtureId`);
      continue;
    }
    const rowLang = r.language ?? lang;
    if (rowLang !== lang) {
      problems.push(`${lang}: row ${fixtureId} declares language "${rowLang}"`);
    }
    if (rows.has(fixtureId)) {
      problems.push(`${lang}: duplicate report row for ${fixtureId}`);
      continue;
    }
    if (!STATUSES.has(r.status)) {
      problems.push(`${lang}: row ${fixtureId} has invalid status "${r.status}"`);
      continue;
    }
    rows.set(fixtureId, {
      fixtureId,
      suite: r.suite ?? null,
      language: lang,
      status: r.status,
      limitation: r.limitation ?? null,
      message: r.message ?? null,
    });
  }
  return { rows, problems };
}

// ---------- synthesized columns (contracts/harness.md ruling 3) ----------

/**
 * ADR-0009: web has its own contracts/web/ suite instead of the shared 65 —
 * the shared fixtures encode async server semantics (awaited evaluation,
 * per-call round trips, lifecycle gating around a promise) a synchronous
 * cache-read surface does not answer, so forcing web through them would
 * produce a wall of pre-declared skips. Every one of the 65 is therefore
 * `not-applicable-web`, not a skip — an absent fixture, not a false-asserting
 * one.
 */
function webRow(fixture) {
  return {
    fixtureId: fixture.id,
    suite: fixture.suite,
    language: 'web',
    status: 'not-applicable-web',
    limitation:
      'ADR-0009: web has its own contracts/web/ suite (async prefetch + synchronous read ' +
      'contract); the shared 65 fixtures encode async server semantics a synchronous ' +
      'cache-read surface cannot answer. See sdks/web/test/conformance/run.ts / ' +
      'compatibility-report.web.json for web\'s real conformance signal.',
    message: null,
  };
}

/** rust/swift have no SDK yet (contracts/harness.md ruling 3, Phase 6). */
function notImplementedRow(fixture, lang) {
  return {
    fixtureId: fixture.id,
    suite: fixture.suite,
    language: lang,
    status: 'not-implemented',
    limitation: `${lang} SDK does not exist yet (Phase 6 of the v1 control-points plan).`,
    message: null,
  };
}

// ---------- comparison ----------

function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const lang of DECLARED_LANGUAGES) {
    if (!args.reports[lang]) usageError(`missing --report ${lang}=<path>`);
  }

  const { fixtures, problems: fixtureProblems } = loadFixtures(args.contracts);
  const violations = fixtureProblems.map((p) => ({ kind: 'fixture', detail: p }));
  const mergedResults = [];
  const perLanguage = {};

  for (const lang of DECLARED_LANGUAGES) {
    let rows;
    try {
      const loaded = loadReport(lang, args.reports[lang]);
      rows = loaded.rows;
      for (const p of loaded.problems) violations.push({ kind: 'report', detail: p });
    } catch (err) {
      usageError(`cannot read report for ${lang} at ${args.reports[lang]}: ${err.message}`);
    }

    const counts = {};
    for (const s of STATUSES) counts[s] = 0;

    for (const [id, fixture] of fixtures) {
      const declared = (fixture.compatibility ?? {})[lang];
      const row = rows.get(id);
      if (!row) {
        violations.push({
          kind: 'missing-cell',
          detail: `${lang}: no report row for fixture ${id} (silent skip is forbidden)`,
        });
        continue;
      }
      rows.delete(id);
      counts[row.status] = (counts[row.status] ?? 0) + 1;
      mergedResults.push(row);

      if (row.status === 'fail') {
        violations.push({
          kind: 'fail',
          detail: `${lang}: ${id} FAILED${row.message ? ` — ${row.message}` : ''}`,
        });
      }
      // Extensions v1-scope carve-out (ruling 2): skipped-v1-out-of-scope
      // against a frozen "pass" declaration is the RULED outcome for the 13
      // classified extension fixtures, not an undeclared divergence.
      const ruledV1Carveout = fixture.suite === 'extensions' && row.status === 'skipped-v1-out-of-scope';
      if (declared && row.status !== declared && !ruledV1Carveout) {
        violations.push({
          kind: 'undeclared-divergence',
          detail:
            `${lang}: ${id} reported "${row.status}" but fixture declares ` +
            `compatibility.${lang} = "${declared}" (status drift requires a fixture update)`,
        });
      }
      if (
        row.status === 'skipped-with-documented-limitation' &&
        !(typeof row.limitation === 'string' && row.limitation.trim())
      ) {
        violations.push({
          kind: 'undocumented-skip',
          detail: `${lang}: ${id} skipped without a limitation string in the report`,
        });
      }
    }

    for (const id of rows.keys()) {
      violations.push({
        kind: 'unknown-fixture',
        detail: `${lang}: report row for unknown fixture "${id}"`,
      });
    }
    perLanguage[lang] = counts;
  }

  // Synthesized columns: no --report file, no fixture-declared baseline to diverge from.
  for (const lang of SYNTHESIZED_LANGUAGES) {
    const counts = {};
    for (const s of STATUSES) counts[s] = 0;
    for (const [, fixture] of fixtures) {
      const row = lang === 'web' ? webRow(fixture) : notImplementedRow(fixture, lang);
      counts[row.status] += 1;
      mergedResults.push(row);
    }
    perLanguage[lang] = counts;
  }

  const webSuite = loadWebSuite(args.webReport);

  const merged = {
    schemaVersion: 1,
    generatedAt: 'EXCLUDED',
    tool: 'tools/conformance/compare.mjs',
    fixtureCount: fixtures.size,
    languages: LANGUAGES,
    summary: perLanguage,
    divergences: violations,
    results: mergedResults,
    // Purely informational; see loadWebSuite's doc comment — never affects
    // `divergences` or the exit code. The key itself is OMITTED (not merely
    // null) when --web-report wasn't passed, so output is byte-identical to
    // before this flag existed unless a caller opts in.
    ...(webSuite ? { webSuite } : {}),
  };

  if (args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, `${JSON.stringify(merged, null, 2)}\n`);
  }

  const lines = [];
  lines.push(`# Fireweave cross-language compatibility report`);
  lines.push('');
  lines.push(`Fixtures: ${fixtures.size} (${fixtures.size} x ${LANGUAGES.length} matrix)`);
  lines.push('');
  lines.push('| language | pass | fail | skipped-with-documented-limitation | skipped-v1-out-of-scope | not-applicable-web | not-implemented |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const lang of LANGUAGES) {
    const c = perLanguage[lang];
    lines.push(
      `| ${lang} | ${c.pass ?? 0} | ${c.fail ?? 0} | ${c['skipped-with-documented-limitation'] ?? 0} | ` +
        `${c['skipped-v1-out-of-scope'] ?? 0} | ${c['not-applicable-web'] ?? 0} | ${c['not-implemented'] ?? 0} |`,
    );
  }
  lines.push('');
  if (violations.length) {
    lines.push(`## Divergences (${violations.length}) — CI FAILURE`);
    lines.push('');
    for (const v of violations) lines.push(`- **${v.kind}**: ${v.detail}`);
  } else {
    lines.push('No undeclared divergence. All skips are fixture-declared with documented limitations.');
  }
  lines.push('');
  if (webSuite) {
    lines.push(`## Web suite (contracts/web/, ADR-0009) — supplementary, not part of the 65x7 matrix above`);
    lines.push('');
    if (webSuite.error) {
      lines.push(`Could not read ${webSuite.path}: ${webSuite.error}`);
    } else {
      lines.push(
        `${webSuite.pass} passed, ${webSuite.fail} failed, ${webSuite.fixtureCount} fixtures total ` +
          `(source: ${webSuite.path}). Gated independently by the "web" CI job's own ` +
          '`bun run conformance` — this section does not affect this report\'s exit code.',
      );
    }
    lines.push('');
  }
  const markdown = lines.join('\n');
  if (args.markdown) {
    mkdirSync(dirname(args.markdown), { recursive: true });
    writeFileSync(args.markdown, markdown);
  }
  process.stdout.write(markdown);

  if (violations.length) {
    process.stderr.write(`\ncompare: ${violations.length} divergence(s) — failing\n`);
    process.exit(1);
  }
}

main();
