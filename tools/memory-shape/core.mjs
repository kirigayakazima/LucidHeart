// Read files directly: never construct MemoryService/Store/Indexer (their constructors write).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { scoreNode, POLICY_VERSION } from './scoring.mjs';

const digest = (s) => crypto.createHash('sha256').update(s).digest('hex');
const known = (s) => typeof s === 'string' && s.trim() && !['unknown', 'none'].includes(s.trim()) ? s.trim() : null;
const arrayStrings = (a) => Array.isArray(a) ? a.filter((s) => typeof s === 'string') : [];
const ACTIONS = new Set(['create', 'update', 'supersede', 'revoke']);
const STATUSES = new Set(['candidate', 'active', 'superseded', 'revoked']);
const KINDS = new Set(['fact', 'episodic', 'preference', 'relationship']);
const SCOPES = new Set(['xiaoman_private', 'axing_private', 'shared']);

export function buildShape({ heartDir, memoryDir, archiveMemoryDirs = [], scope, now = new Date().toISOString(),
  timezoneOffset = '+08:00', halfLifeDays = 30, maxNodes = 10000, maxFileBytes = 16 * 1024 * 1024 } = {}) {
  if (!heartDir || !memoryDir || !SCOPES.has(scope)) throw new Error('Explicit heartDir, active memoryDir and scope required');
  if (!/^[+-](?:0\d|1[0-4]):[0-5]\d$/.test(timezoneOffset)) throw new Error('Invalid timezone offset');
  if (!Number.isFinite(Date.parse(now))) throw new Error('Invalid clock');
  const roots = [heartDir, memoryDir, ...archiveMemoryDirs].map((r) => fs.realpathSync(r));
  if (new Set(roots).size !== roots.length) throw new Error('Duplicate source roots');
  const report = { schemaVersion: 1, toolVersion: '0.1.0', generatedAt: now, readOnly: true,
    authority: { engine: '@dsh/memory', memoryDir: roots[1], selection: 'operator-selected; verify against loaded plugin config', scope },
    policy: { version: POLICY_VERSION, mode: 'shadow-only', halfLifeDays, timezoneOffset, queryRelevance: 'not-evaluated' },
    snapshotConsistency: 'per-file-stable; not an atomic snapshot across sources',
    sources: [], warnings: [], omitted: { revoked: 0, superseded: 0, rejected: 0, otherScope: 0 }, nodes: [], groups: [], edges: [] };
  const warn = (file, code, line) => report.warnings.push({ file, code, ...(line ? { line } : {}) });
  function read(root, rel, required = false) {
    // Heart history has no per-record audience. A shared export cannot relabel it as shared.
    if (scope === 'shared' && root === roots[0]) return null;
    const file = path.join(root, rel);
    try {
      const before = fs.statSync(file);
      if (!before.isFile() || before.size > maxFileBytes) throw new Error('FILE_LIMIT_OR_TYPE');
      const data = fs.readFileSync(file);
      const after = fs.statSync(file);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error('SOURCE_CHANGED_DURING_READ');
      report.sources.push({ file, bytes: data.length, sha256: digest(data) });
      return data.toString('utf8').replace(/^\uFEFF/, '');
    } catch (e) {
      if (e.code !== 'ENOENT' || required) warn(file, e.code === 'ENOENT' ? 'SOURCE_MISSING' : 'SOURCE_UNREADABLE_OR_UNSTABLE');
      return null;
    }
  }
  function add(node) {
    if (report.nodes.length >= maxNodes) throw new Error('NODE_LIMIT: narrow sources before exporting');
    node.score = scoreNode(node, { now, halfLifeDays });
    node.weight = node.score.displayWeight;
    report.nodes.push(node);
  }
  function base(root, rel, line, type, text, layer) {
    const locator = `${rel}:${line}`;
    return { id: digest(`${root}\0${locator}\0${text}`), type, text, layer, t: null, tags: [], src: null,
      via: 'unknown', status: 'historical', confidence: null, scope, pinned: false, category: null,
      origin: { file: path.join(root, rel), line, locator } };
  }
  function markdown(rel, type, layer) {
    const body = read(roots[0], rel);
    if (body === null) return;
    body.split(/\r?\n/).forEach((line, i) => {
      const match = line.match(/^\s*[-*]\s+(.+)/);
      if (!match) return;
      const n = base(roots[0], rel, i + 1, type, match[1], layer);
      if (type === 'principle') {
        n.status = 'recorded-principle'; n.pinned = true; n.via = 'self';
        const date = n.text.match(/^(\d{4}-\d{2}-\d{2})\s+(.+)/);
        if (date) { n.date = date[1]; n.text = date[2]; }
      }
      add(n);
    });
  }
  markdown('notebook.md', 'principle', 'principles');
  markdown('facts.md', 'fact', 'legacy');
  const srcBody = read(roots[0], 'src-index.json');
  let srcIndex = {};
  if (srcBody !== null) {
    try { srcIndex = JSON.parse(srcBody); if (!srcIndex || typeof srcIndex !== 'object' || Array.isArray(srcIndex)) throw new Error(); }
    catch { srcIndex = {}; warn('src-index.json', 'INVALID_SESSION_INDEX'); }
  }
  const episodeDir = path.join(roots[0], 'MEMORY');
  let files = [];
  try { files = fs.readdirSync(episodeDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.[\w-]+\.md$/.test(f)).sort(); }
  catch (e) { if (e.code !== 'ENOENT') warn(episodeDir, 'DIRECTORY_UNREADABLE'); }
  for (const filename of files) {
    const rel = `MEMORY/${filename}`;
    const body = read(roots[0], rel);
    if (body === null) continue;
    body.split(/\r?\n/).forEach((line, i) => {
      if (!/^\s*[-*]\s/.test(line)) return;
      const match = line.match(/^\s*[-*]\s+(\d{2}:\d{2})\s+\[([^\]]+)\]\s+(.+?)(?:\s+·\s+src:(\S+)\s+via:(\w+))?\s*$/);
      if (!match) { warn(rel, 'UNPARSED_EPISODE_LINE', i + 1); return; }
      const n = base(roots[0], rel, i + 1, 'episodic', match[3], 'legacy');
      const t = `${filename.slice(0, 10)}T${match[1]}:00${timezoneOffset}`;
      n.t = Number.isFinite(Date.parse(t)) ? new Date(t).toISOString() : null;
      n.src = known(match[4]); n.via = ['self', 'chat'].includes(match[5]) ? match[5] : 'unknown';
      n.device = match[2];
      // Exact table lookup only. An eight-character prefix alone is not a full session identity.
      n.session = known(srcIndex[n.src]?.session);
      add(n);
    });
  }
  const dream = read(roots[0], 'dream/insights.json');
  if (dream !== null) {
    let insights;
    try { insights = JSON.parse(dream); if (!Array.isArray(insights)) throw new Error(); }
    catch { warn('dream/insights.json', 'INVALID_INSIGHTS_JSON'); }
    if (insights) {
      for (const [i, item] of insights.entries()) {
        if (!item || typeof item.statement !== 'string' || !['candidate', 'confirmed', 'rejected', 'promoted'].includes(item.status)) {
          warn('dream/insights.json', 'INVALID_INSIGHT', i + 1); continue;
        }
        if (item.status === 'rejected') { report.omitted.rejected++; continue; }
        const n = base(roots[0], 'dream/insights.json', i + 1, 'insight', item.statement, 'dream');
        n.sourceId = item.id; n.status = item.status; n.category = known(item.category);
        n.session = known(item.source?.session); n.src = n.session;
        n.confidence = item.confidence; n.t = item.createdAt || null;
        n.claimKind = item.type; add(n);
      }
    }
  }
  for (const [rootIndex, root] of roots.entries()) {
    if (rootIndex === 0) continue;
    const body = read(root, 'journal.jsonl', true);
    if (body === null) continue;
    const entries = new Map();
    let corrupt = false;
    body.split(/\r?\n/).forEach((line, i) => {
      if (!line.trim()) return;
      try {
        const record = JSON.parse(line);
        const e = record.entry;
        if (!ACTIONS.has(record.action) || !e || typeof e.id !== 'string' || typeof e.content !== 'string'
          || !STATUSES.has(e.status) || !KINDS.has(e.kind) || !SCOPES.has(e.scope)) throw new Error();
        const entry = { ...e, status: record.action === 'revoke' ? 'revoked' : e.status };
        entries.set(e.id, { entry, line: i + 1 });
        if (record.action === 'supersede' && e.supersedesId && entries.has(e.supersedesId)) {
          entries.get(e.supersedesId).entry.status = 'superseded';
        }
      } catch { corrupt = true; warn(path.join(root, 'journal.jsonl'), 'INVALID_JOURNAL_RECORD', i + 1); }
    });
    // Skipping a broken revoke could revive a forgotten record. Fail this entire source closed.
    if (corrupt) { warn(root, 'JOURNAL_SOURCE_SUPPRESSED'); continue; }
    for (const { entry: e, line } of entries.values()) {
      if (e.scope !== scope && e.scope !== 'shared') { report.omitted.otherScope++; continue; }
      if (['revoked', 'superseded'].includes(e.status)) { report.omitted[e.status]++; continue; }
      const n = base(root, 'journal.jsonl', line, e.kind, e.content, rootIndex === 1 ? 'current' : 'archive');
      n.id = digest(`${root}\0${e.id}`); n.sourceId = e.id; n.status = e.status; n.scope = e.scope;
      n.t = e.validFrom || e.createdAt || null; n.validFrom = e.validFrom; n.validTo = e.validTo;
      n.confidence = e.confidence; n.pinned = e.pinned === true;
      n.tags = arrayStrings(e.tags); n.category = e.kind;
      n.session = known(e.source?.sessionId); n.src = n.session;
      n.via = ['chat', 'self'].includes(e.source?.via) ? e.source.via : 'unknown';
      add(n);
    }
  }
  // Group hubs are O(nodes), unlike pairwise cliques. These are shared metadata, not semantic/causal assertions.
  const groups = new Map();
  for (const n of report.nodes) {
    for (const [type, value] of [['same-src', n.session || n.src], ['same-category', n.category]]) {
      if (!known(value)) continue;
      const key = `${n.layer}\0${n.scope}\0${type}\0${value}`;
      if (!groups.has(key)) groups.set(key, { id: `group:${digest(key)}`, type, value, layer: n.layer, scope: n.scope, members: [] });
      groups.get(key).members.push(n.id);
    }
  }
  for (const g of groups.values()) {
    if (g.members.length < 2) continue;
    report.groups.push(g);
    for (const id of g.members) report.edges.push({ source: id, target: g.id, type: g.type });
  }
  report.complete = report.warnings.length === 0;
  const connected = new Set(report.edges.map((e) => e.source));
  report.summary = { nodes: report.nodes.length, groups: report.groups.length, edges: report.edges.length,
    isolated: report.nodes.filter((n) => !connected.has(n.id)).length };
  return report;
}
