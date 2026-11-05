import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildShape } from './core.mjs';

const { values: a } = parseArgs({ options: {
  'heart-dir': { type: 'string' }, 'memory-dir': { type: 'string' },
  'archive-memory-dir': { type: 'string', multiple: true }, scope: { type: 'string' },
  out: { type: 'string' }, now: { type: 'string' }, 'timezone-offset': { type: 'string', default: '+08:00' },
  'half-life-days': { type: 'string', default: '30' }, help: { type: 'boolean' },
} });
if (a.help) {
  console.log('node export.mjs --heart-dir PATH --memory-dir ACTIVE_PATH --scope xiaoman_private|axing_private|shared --out NEW_FILE.json [--archive-memory-dir PATH]');
} else {
  try {
    if (!a.out || !a['heart-dir'] || !a['memory-dir'] || !a.scope) throw new Error('Use --help: explicit roots, scope and output are required');
    const out = path.resolve(a.out);
    const parent = fs.realpathSync(path.dirname(out));
    for (const root of [a['heart-dir'], a['memory-dir'], ...(a['archive-memory-dir'] || [])]) {
      const relative = path.relative(fs.realpathSync(root), parent);
      if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
        throw new Error('OUTPUT_INSIDE_SOURCE: choose a separate export directory');
      }
    }
    const report = buildShape({ heartDir: a['heart-dir'], memoryDir: a['memory-dir'],
      archiveMemoryDirs: a['archive-memory-dir'], scope: a.scope, now: a.now,
      timezoneOffset: a['timezone-offset'], halfLifeDays: Number(a['half-life-days']) });
    fs.writeFileSync(path.join(parent, path.basename(out)), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    // No memory text on stdout; export itself is private and must not be committed.
    console.log(JSON.stringify({ output: out, complete: report.complete, ...report.summary, warnings: report.warnings.length }));
    if (!report.complete) process.exitCode = 2;
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
