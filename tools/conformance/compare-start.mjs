#!/usr/bin/env node
/**
 * compare-start.mjs — validates contracts/start/ and aggregates the per-language
 * start-profile reports (contracts/start/README.md, spec/start-profile.md).
 *
 * Usage:
 *   node tools/conformance/compare-start.mjs [--contracts contracts/start]
 *        [--report node=sdks/node/test/conformance/compatibility-report.start.node.json ...]
 *
 * 1. Every fixture is validated against start-fixture.schema.json with the small
 *    JSON Schema subset the schema uses (no dependency: this repo's tools stay
 *    zero-dep, like compare.mjs). Then the cross-field rules the schema cannot
 *    express: the id matches the file name, case names are unique, every
 *    non-pass compatibility cell has a limitation, and appliesTo names only
 *    languages the fixture marks applicable.
 * 2. Each given report is checked against the fixtures: a language must report
 *    every fixture it declares `pass` for, and report it passing.
 *
 * Exit: 0 clean, 1 a report contradicts a declared pass, 2 a fixture or schema problem.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const LANGS = ['node', 'web', 'python', 'go', 'java', 'rust', 'swift', 'dart'];

function parseArgs(argv) {
  const out = { contracts: 'contracts/start', reports: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--contracts') out.contracts = next();
    else if (a === '--report') {
      const [lang, path] = next().split('=');
      if (!LANGS.includes(lang) || !path) throw new Error(`--report expects <lang>=<path>, got '${argv[i]}'`);
      out.reports[lang] = path;
    } else throw new Error(`unknown argument '${a}'`);
  }
  return out;
}

// ---- the JSON Schema subset start-fixture.schema.json uses ----
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v;
}

function validate(schema, value, root, path, errors) {
  if (schema.$ref) {
    const name = schema.$ref.replace('#/$defs/', '');
    return validate(root.$defs[name], value, root, path, errors);
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((s) => {
      const e = [];
      validate(s, value, root, path, e);
      return e.length === 0;
    });
    if (matches.length !== 1) errors.push(`${path}: matches ${matches.length} of the allowed shapes (expected exactly 1)`);
    return;
  }
  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${path}: must be ${JSON.stringify(schema.const)}`);
    return;
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
    return;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const t = typeOf(value);
    if (!types.includes(t) && !(t === 'integer' && types.includes('number'))) {
      errors.push(`${path}: must be ${types.join(' or ')}, got ${t}`);
      return;
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: too short`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path}: must match ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: needs at least ${schema.minItems} item(s)`);
    if (schema.items) value.forEach((v, i) => validate(schema.items, v, root, `${path}[${i}]`, errors));
  }
  if (typeOf(value) === 'object') {
    for (const r of schema.required ?? []) if (!(r in value)) errors.push(`${path}: missing '${r}'`);
    for (const [k, v] of Object.entries(value)) {
      const p = `${path}.${k}`;
      if (schema.properties && k in schema.properties) validate(schema.properties[k], v, root, p, errors);
      else {
        const pat = Object.entries(schema.patternProperties ?? {}).find(([re]) => new RegExp(re, 'u').test(k));
        if (pat) validate(pat[1], v, root, p, errors);
        else if (schema.additionalProperties === false) errors.push(`${p}: unknown field`);
        else if (typeof schema.additionalProperties === 'object') validate(schema.additionalProperties, v, root, p, errors);
      }
    }
  }
}

function crossChecks(fx, file, errors) {
  if (fx.id !== basename(file, '.json')) errors.push(`${file}: id '${fx.id}' does not match the file name`);
  const names = new Set();
  for (const c of fx.cases ?? []) {
    if (names.has(c.name)) errors.push(`${file}: duplicate case name '${c.name}'`);
    names.add(c.name);
    for (const l of c.appliesTo ?? []) {
      if (fx.compatibility?.[l] === 'not-applicable') errors.push(`${file}: case '${c.name}' applies to ${l}, but the fixture marks ${l} not-applicable`);
    }
  }
  for (const l of LANGS) {
    const status = fx.compatibility?.[l];
    if (status && status !== 'pass' && !fx.limitations?.[l]) errors.push(`${file}: ${l} is '${status}' without a limitations.${l} reason`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const schema = JSON.parse(readFileSync(join(args.contracts, 'start-fixture.schema.json'), 'utf8'));
  const files = readdirSync(args.contracts).filter((f) => f.endsWith('.json') && f !== 'start-fixture.schema.json').sort();
  const fixtures = [];
  const problems = [];
  for (const f of files) {
    const fx = JSON.parse(readFileSync(join(args.contracts, f), 'utf8'));
    const errs = [];
    validate(schema, fx, schema, f, errs);
    crossChecks(fx, f, errs);
    problems.push(...errs);
    fixtures.push(fx);
  }
  const caseCount = fixtures.reduce((n, fx) => n + fx.cases.length, 0);
  console.log(`start suite: ${fixtures.length} fixtures, ${caseCount} cases, ${problems.length} schema problem(s)`);
  for (const p of problems) console.log(`  SCHEMA ${p}`);
  if (problems.length > 0) process.exit(2);

  let mismatches = 0;
  const rows = [];
  for (const fx of fixtures) {
    const row = [fx.id];
    for (const l of LANGS) {
      const declared = fx.compatibility[l];
      const path = args.reports[l];
      if (!path) {
        row.push(declared === 'pass' ? '·' : '-');
        continue;
      }
      const report = JSON.parse(readFileSync(path, 'utf8'));
      const result = report.results.find((r) => r.fixtureId === fx.id);
      if (declared !== 'pass') {
        row.push('-');
        continue;
      }
      if (!result || result.status !== 'pass') {
        mismatches++;
        row.push('FAIL');
        console.log(`  MISMATCH ${l} ${fx.id}: declared pass, reported ${result ? result.status : 'nothing'}${result?.message ? ` (${result.message})` : ''}`);
      } else row.push('ok');
    }
    rows.push(row);
  }
  if (Object.keys(args.reports).length > 0) {
    console.log(['fixture', ...LANGS].join('\t'));
    for (const r of rows) console.log(r.join('\t'));
    console.log('legend: ok = passed, FAIL = declared pass but did not pass, - = not applicable, · = no report given');
  }
  process.exit(mismatches > 0 ? 1 : 0);
}

main();
