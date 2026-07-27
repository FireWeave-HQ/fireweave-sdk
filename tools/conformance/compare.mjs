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
 *      (undeclared divergence / silent status drift)              -> FAIL
 *   3. Missing fixture x language cell in a report                -> FAIL
 *   4. Report row for an unknown fixture id                       -> FAIL
 *   5. skipped-with-documented-limitation without limitation text
 *      (in fixture or report)                                     -> FAIL
 *   6. Duplicate fixture ids / missing compatibility entries      -> FAIL
 *
 * Accepts both report dialects that the SDKs emit today:
 *   - harness.md schema: { schemaVersion, results: [{fixtureId, ...}], summary }
 *     (node, go, java)
 *   - python runner schema: { language, total, passed, failed, skipped,
 *     results: [{id, suite, status, ...}] }
 *
 * Usage:
 *   node tools/conformance/compare.mjs \
 *     --contracts contracts \
 *     --report node=path.json --report python=path.json \
 *     --report go=path.json --report java=path.json \
 *     --out build/conformance/compatibility-report.json \
 *     [--markdown build/conformance/summary.md]
 *
 * Zero dependencies; Node >= 20. Exit code 0 = no divergence, 1 = divergence,
 * 2 = usage / IO error.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

const LANGUAGES = ['node', 'python', 'go', 'java'];
const SUITES = ['evaluation', 'context', 'lifecycle', 'faults', 'security', 'extensions'];
const STATUSES = new Set(['pass', 'fail', 'skipped-with-documented-limitation']);

function usageError(msg) {
  process.stderr.write(`compare: ${msg}\n`);
  process.exit(2);
}

// ---------- argument parsing ----------

function parseArgs(argv) {
  const args = { contracts: 'contracts', reports: {}, out: null, markdown: null };
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
    else if (a === '--report') {
      const v = next();
      const eq = v.indexOf('=');
      if (eq < 1) usageError(`--report expects <lang>=<path>, got "${v}"`);
      const lang = v.slice(0, eq);
      if (!LANGUAGES.includes(lang)) usageError(`unknown language "${lang}"`);
      args.reports[lang] = v.slice(eq + 1);
    } else usageError(`unknown argument "${a}"`);
  }
  return args;
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
      for (const lang of LANGUAGES) {
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
    const fixtureId = r.fixtureId ?? r.id;
    if (!fixtureId) {
      problems.push(`${lang}: report row without fixtureId/id`);
      continue;
    }
    const rowLang = r.language ?? raw.language ?? lang;
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

// ---------- comparison ----------

function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const lang of LANGUAGES) {
    if (!args.reports[lang]) usageError(`missing --report ${lang}=<path>`);
  }

  const { fixtures, problems: fixtureProblems } = loadFixtures(args.contracts);
  const violations = fixtureProblems.map((p) => ({ kind: 'fixture', detail: p }));
  const mergedResults = [];
  const perLanguage = {};

  for (const lang of LANGUAGES) {
    let rows;
    try {
      const loaded = loadReport(lang, args.reports[lang]);
      rows = loaded.rows;
      for (const p of loaded.problems) violations.push({ kind: 'report', detail: p });
    } catch (err) {
      usageError(`cannot read report for ${lang} at ${args.reports[lang]}: ${err.message}`);
    }

    const counts = { pass: 0, fail: 0, 'skipped-with-documented-limitation': 0 };

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
      counts[row.status] += 1;
      mergedResults.push(row);

      if (row.status === 'fail') {
        violations.push({
          kind: 'fail',
          detail: `${lang}: ${id} FAILED${row.message ? ` — ${row.message}` : ''}`,
        });
      }
      if (declared && row.status !== declared) {
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

  const merged = {
    schemaVersion: 1,
    generatedAt: 'EXCLUDED',
    tool: 'tools/conformance/compare.mjs',
    fixtureCount: fixtures.size,
    languages: LANGUAGES,
    summary: perLanguage,
    divergences: violations,
    results: mergedResults,
  };

  if (args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, `${JSON.stringify(merged, null, 2)}\n`);
  }

  const lines = [];
  lines.push(`# Fireweave cross-language compatibility report`);
  lines.push('');
  lines.push(`Fixtures: ${fixtures.size}`);
  lines.push('');
  lines.push('| language | pass | fail | skipped-with-documented-limitation |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const lang of LANGUAGES) {
    const c = perLanguage[lang];
    lines.push(`| ${lang} | ${c.pass} | ${c.fail} | ${c['skipped-with-documented-limitation']} |`);
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
