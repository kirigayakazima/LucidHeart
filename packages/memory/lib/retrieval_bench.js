const DAY_MS = 86_400_000;
const unit = (value, fallback) => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
const top3 = ids => [...new Set(ids)].slice(0, 3);

export function compareRankings(baselineIds, shadowIds, relevantIds) {
  const baseline = top3(baselineIds), shadow = top3(shadowIds);
  const union = new Set([...baseline, ...shadow]);
  const intersection = baseline.filter(id => shadow.includes(id)).length;
  const reference = relevantIds === undefined ? baseline.slice(0, 1) : relevantIds;
  const relevant = new Set(reference);
  function rr(ranking) {
    const hit = ranking.findIndex(id => relevant.has(id));
    return hit < 0 ? 0 : 1 / (hit + 1);
  }
  const fts = relevant.size ? rr(baseline) : null;
  const reranked = relevant.size ? rr(shadow) : null;
  return { jaccardAt3: union.size ? intersection / union.size : 1,
    mrrAt3: { fts, shadow: reranked, delta: fts === null ? null : reranked - fts },
    mrrReference: relevantIds === undefined ? (relevant.size ? 'fts_top1_proxy' : 'unlabeled') : 'gold' };
}

export function benchmarkRetrieval(cases) {
  const reports = cases.map(({ baselineIds, shadowIds, relevantIds }) => {
    if (!Array.isArray(relevantIds) || !relevantIds.length) throw new TypeError('Offline MRR requires labeled relevant IDs');
    return compareRankings(baselineIds, shadowIds, relevantIds);
  });
  if (!reports.length) throw new RangeError('No retrieval cases');
  const mean = read => reports.reduce((sum, row) => sum + read(row), 0) / reports.length;
  return { count: reports.length, meanJaccardAt3: mean(row => row.jaccardAt3),
    mrrAt3: { fts: mean(row => row.mrrAt3.fts), shadow: mean(row => row.mrrAt3.shadow), delta: mean(row => row.mrrAt3.delta) } };
}

export function rankShadow(rows, at, mood) {
  const strongest = Math.max(0, ...rows.map(row => -row.rank));
  return rows.map((row, index) => {
    const entry = JSON.parse(row.raw_json);
    const relevance = strongest > 0 ? unit(-row.rank / strongest, 0) : 0;
    const importance = unit(entry.salience?.importance ?? entry.importance, 0.5);
    const ageDays = (at - Date.parse(entry.updatedAt ?? entry.createdAt)) / DAY_MS;
    const recency = Number.isFinite(ageDays) ? 1 / (1 + Math.max(0, ageDays) / 30) : 0;
    const retention = entry.retentionClass === 'pinned' ? 1 : entry.retentionClass === 'stable' ? 0.5 : 0;
    const emotion = typeof mood === 'string' && /^[a-z_]{1,32}$/.test(mood) &&
      Array.isArray(entry.tags) && entry.tags.includes(`mood:${mood}`) ? 1 : 0;
    const score = 0.75 * relevance + 0.15 * importance + 0.07 * recency + 0.03 * retention + 0.05 * emotion;
    return { id: entry.id, index, score, relevance, importance, recency, retention, emotion };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
}
