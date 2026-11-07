import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const fixture = JSON.parse(await readFile(new URL('./scenarios.json', import.meta.url), 'utf8'));
const dimensions = ['continuity', 'empathy', 'naturalness'];

function grade(run) {
  if (!run.model || run.scenarioVersion !== fixture.version || run.rows.length !== fixture.cases.length) {
    throw new Error('Each run must use this fixture version and cover every case once');
  }
  const results = new Map(run.rows.map(row => [row.id, row]));
  if (results.size !== fixture.cases.length) throw new Error('Duplicate scenario result');
  return fixture.cases.map(scenario => {
    const row = results.get(scenario.id);
    if (!row || typeof row.reply !== 'string' || !Array.isArray(row.labels) ||
        !Number.isFinite(row.latencyMs) || row.latencyMs < 0 || !Number.isSafeInteger(row.tokens) || row.tokens < 0 ||
        dimensions.some(key => ![0, 1, 2].includes(row.ratings?.[key]))) {
      throw new Error(`Incomplete adjudication for ${scenario.id}`);
    }
    const labels = new Set(row.labels);
    const missing = scenario.required.filter(label => !labels.has(label));
    const forbidden = scenario.forbidden.filter(label => labels.has(label));
    return { ...row, missing, forbidden, passed: missing.length === 0 && forbidden.length === 0 };
  });
}

export function compareRuns(baseline, candidate) {
  const before = grade(baseline);
  const after = grade(candidate);
  const mean = (rows, metric) => rows.reduce((total, row) => total + metric(row), 0) / rows.length;
  const aggregate = (run, rows) => ({
    model: run.model, passed: rows.filter(row => row.passed).length,
    meanLatencyMs: mean(rows, row => row.latencyMs), totalTokens: rows.reduce((n, row) => n + row.tokens, 0),
    ratings: Object.fromEntries(dimensions.map(key => [key, mean(rows, row => row.ratings[key])])),
  });
  return {
    baseline: aggregate(baseline, before), candidate: aggregate(candidate, after),
    regressions: after.flatMap((row, i) => {
      const lowered = dimensions.filter(key => row.ratings[key] < before[i].ratings[key]);
      const failed = before[i].passed && !row.passed;
      return failed || lowered.length ? [{ id: row.id, lowered, missing: row.missing, forbidden: row.forbidden }] : [];
    }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = process.argv.slice(2);
  if (files.length !== 2) throw new Error('Usage: node compare.mjs <baseline.json> <candidate.json>');
  const runs = await Promise.all(files.map(async file => JSON.parse(await readFile(file, 'utf8'))));
  const comparison = compareRuns(...runs);
  console.log(JSON.stringify(comparison, null, 2));
  if (comparison.regressions.length) process.exitCode = 1;
}
