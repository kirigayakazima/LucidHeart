import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MemoryService } from '../lib/service.js';

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-mutation-'));
  const opened = [];
  t.after(() => {
    for (const memory of opened) memory.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const open = () => {
    const memory = new MemoryService({ dataDir });
    opened.push(memory);
    return memory;
  };
  const journal = path.join(dataDir, 'journal.jsonl');
  const bytes = () => fs.readFileSync(journal);
  const records = () => bytes().toString().trim().split('\n').map(JSON.parse);
  const memory = open();
  const old = memory.remember({ kind: 'preference', content: '我喜欢喝乌龙茶' });
  return { open, memory, old, journal, bytes, records };
}

test('one synced mutation carries replaces and entry before FTS updates, and restart retires old facts', t => {
  const { open, memory, old, records } = fixture(t);
  const sync = fs.fsyncSync;
  let synced = false;
  t.mock.method(fs, 'fsyncSync', fd => {
    assert.equal(records().length, 2);
    const record = records().at(-1);
    assert.equal(record.mutationVersion, 1);
    assert.equal(record.operationId, record.entry.id);
    assert.deepEqual(record.replaces, [old.id]);
    assert.equal(record.entry.supersedesId, old.id);
    assert.match(record.checksum, /^[0-9a-f]{64}$/);
    sync(fd);
    synced = true;
  });
  t.mock.method(memory.indexer, 'upsertAll', () => {
    assert.equal(synced, true);
    throw Error('simulated crash after journal sync');
  });
  assert.throws(() => memory.correct(old.id, '我喜欢喝冰红茶'), {
    message: 'simulated crash after journal sync', durable: true, projection: 'degraded',
  });
  assert.throws(() => memory.indexer.search('乌龙茶'), { code: 'MEMORY_PROJECTION_UNAVAILABLE' });
  const replacement = records().at(-1).entry;
  memory.close();
  const recovered = open();
  assert.equal(recovered.inspect(old.id).supersededBy, replacement.id);
  assert.equal(recovered.recall('乌龙茶').count, 0);
  assert.equal(recovered.recall('冰红茶').entries[0].id, replacement.id);
  assert.equal(recovered.correct(old.id, '我喜欢喝冰红茶').id, replacement.id);
  assert.equal(records().length, 2);
});

test('a torn append blocks reads and writes in the current process and after reopening', t => {
  const { memory, old, open, bytes } = fixture(t);
  const write = fs.writeSync;
  const shortWrite = t.mock.method(fs, 'writeSync', (fd, data, ...args) => {
    if (Buffer.isBuffer(data) && data.includes('"mutationVersion"')) return write(fd, data.subarray(0, -12));
    return write(fd, data, ...args);
  });
  assert.throws(() => memory.correct(old.id, '我喜欢喝冰红茶'), /Incomplete memory journal append/);
  shortWrite.mock.restore();
  const torn = bytes();
  assert.throws(() => memory.recall('乌龙茶'), { code: 'MEMORY_JOURNAL_CORRUPT', line: 2 });
  assert.throws(() => memory.inspect(old.id), { code: 'MEMORY_JOURNAL_CORRUPT' });
  assert.throws(() => memory.remember({ content: '下一条记录' }), { code: 'MEMORY_JOURNAL_CORRUPT' });
  assert.throws(() => memory.commitments.find('约定'), { code: 'MEMORY_JOURNAL_CORRUPT' });
  assert.throws(() => memory.projects.list('xiaoman_private'), { code: 'MEMORY_JOURNAL_CORRUPT' });
  assert.throws(() => memory.indexer.search('乌龙茶'), { code: 'MEMORY_PROJECTION_UNAVAILABLE' });
  memory.close();
  assert.throws(open, { code: 'MEMORY_JOURNAL_CORRUPT', line: 2 });
  assert.deepEqual(bytes(), torn);
});

test('a process exiting between fsync and FTS commit leaves a replayable replacement', t => {
  const { memory, old, open, journal, records } = fixture(t);
  memory.close();
  const module = new URL('../lib/service.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { MemoryService } from ${JSON.stringify(module)};
    const [, dataDir, id] = process.argv;
    const memory = new MemoryService({ dataDir });
    memory.indexer.upsertAll = () => process.exit(77);
    memory.correct(id, '我喜欢喝冰红茶');
  `, path.dirname(journal), old.id], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 77, child.stderr || child.error?.message);
  const recovered = open();
  assert.equal(records().length, 2);
  assert.equal(recovered.recall('乌龙茶').count, 0);
  assert.equal(recovered.recall('冰红茶').entries[0].id, records().at(-1).entry.id);
});

test('an ambiguous fsync blocks projection until a successful sync, then retries reuse the mutation', t => {
  const { memory, old, records } = fixture(t);
  const failure = t.mock.method(fs, 'fsyncSync', () => { throw Error('simulated fsync failure'); });
  assert.throws(() => memory.correct(old.id, '我喜欢喝冰红茶'), /simulated fsync failure/);
  assert.throws(() => memory.recall('乌龙茶'), /simulated fsync failure/);
  assert.equal(records().length, 2);
  failure.mock.restore();
  const recovered = memory.correct(old.id, '我喜欢喝冰红茶');
  assert.equal(records().at(-1).entry.id, recovered.id);
  assert.equal(memory.inspect(old.id).status, 'superseded');
  assert.equal(records().length, 2);
});

test('corrupt interior events and altered or unterminated mutations fail closed without editing the journal', t => {
  const { memory, old, journal, bytes, records } = fixture(t);
  memory.correct(old.id, '我喜欢喝冰红茶');
  const valid = bytes();
  const [first, mutation] = records();
  for (const [text, reason] of [
    [`${JSON.stringify(first)}\n{broken\n${JSON.stringify(mutation)}\n`, 'invalid JSON'],
    [`${JSON.stringify(first)}\n${JSON.stringify({ ...mutation, entry: { ...mutation.entry, content: '改写' } })}\n`, 'checksum'],
    [valid.toString().trimEnd(), 'unterminated mutation'],
    [`${valid}${JSON.stringify({ action: 'update', entry: first.entry })}\n`, 'reactivation'],
  ]) {
    fs.writeFileSync(journal, text);
    assert.throws(() => memory.project('乌龙茶'), { code: 'MEMORY_JOURNAL_CORRUPT', message: new RegExp(reason) });
    assert.deepEqual(bytes(), Buffer.from(text));
    assert.throws(() => memory.indexer.getAllActive(), { code: 'MEMORY_PROJECTION_UNAVAILABLE' });
  }
  fs.writeFileSync(journal, valid);
  assert.equal(memory.recall('乌龙茶').count, 0);
  assert.equal(memory.recall('冰红茶').count, 1);
});

test('a failed Markdown projection keeps service and indexer reads closed until all projections recover', t => {
  const { memory, old } = fixture(t);
  const failure = t.mock.method(memory.store, 'syncMarkdownView', () => { throw Error('simulated Markdown failure'); });
  assert.throws(() => memory.correct(old.id, '我喜欢喝冰红茶'), { durable: true, projection: 'degraded' });
  assert.throws(() => memory.recall('乌龙茶'), /simulated Markdown failure/);
  assert.throws(() => memory.indexer.search('冰红茶'), { code: 'MEMORY_PROJECTION_UNAVAILABLE' });
  failure.mock.restore();
  assert.equal(memory.recall('乌龙茶').count, 0);
  assert.equal(memory.recall('冰红茶').count, 1);
  assert.match(fs.readFileSync(memory.store.factsPath, 'utf8'), /冰红茶/);
});
