import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AlbumLedger, apply } from '../lib/index.js';

const entry = { kind: 'video_storyboard', title: '蓝发女仆装眨眼星光', summary: '十秒竖屏视频里出现眨眼和星光闪烁',
  source_hash: createHash('sha256').update('video-fixture').digest('hex'), user_quote: '这个是给你做的视频哦', tags: ['breeze', '视频'] };

test('album appends once, survives reload and retrieves keywords and time without touching facts', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-album-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const journal = path.join(root, 'journal.jsonl');
  fs.writeFileSync(journal, 'fact journal fixture must stay byte-for-byte identical\n');
  const before = fs.readFileSync(journal);
  const album = new AlbumLedger(root);
  const first = album.save(entry, new Date('2026-11-18T19:30:00+08:00'));
  assert.match(first.entry.id, /^alb_[a-f0-9]{8}$/);
  assert.equal(first.created, true);
  const repeated = new AlbumLedger(root).save({ ...entry, title: '改标题也不重复存' });
  assert.equal(repeated.created, false);
  assert.equal(repeated.entry.title, entry.title);
  album.save({ ...entry, kind: 'user_photo', media: Buffer.from('second image'), title: '旅行风景' }, new Date('2026-11-19T10:00:00+08:00'));
  assert.deepEqual(album.search('蓝发')[0], first.entry);
  assert.equal(album.search('breeze 视频').length, 2);
  assert.equal(album.search('', { after: '2026-11-19T00:00:00+08:00' })[0].title, '旅行风景');
  assert.equal(album.search('', { before: '2026-11-18T23:59:59+08:00' }).length, 1);
  assert.equal(album.search('没有的画面').length, 0);
  assert.deepEqual(fs.readFileSync(journal), before);
  assert.equal(fs.readFileSync(album.file, 'utf8').trim().split('\n').length, 2);
  fs.appendFileSync(album.file, '{"id":"partial');
  const corrupt = fs.readFileSync(album.file);
  assert.throws(() => album.search(), /Incomplete/);
  assert.throws(() => album.save({ ...entry, source_hash: 'f'.repeat(64) }), /Incomplete/);
  assert.deepEqual(fs.readFileSync(album.file), corrupt);
  assert.deepEqual(fs.readFileSync(journal), before);
});

test('album tools bind real host provenance, reject fabricated quotes and share one visual history', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-album-tools-'));
  const tools = new Map(), disposers = [];
  let memory;
  apply({ tools: { register(tool) { tools.set(tool.name, tool); } },
    effect(callback) { disposers.push(callback()); }, provide(_name, value) { memory = value; } },
  { dataDir: root, scope: 'xiaoman_private' });
  t.after(() => { disposers.reverse().forEach(dispose => dispose?.()); fs.rmSync(root, { recursive: true, force: true }); });
  memory.remember({ content: '测试相册与事实分开。', scope: 'xiaoman_private' });
  const before = fs.readFileSync(memory.store.journalPath);
  const exec = kind => ({ agent: { id: 'owner', session: { id: 'owner', events: [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', time: Date.parse('2026-11-18T19:30:00+08:00'), data: {
      id: 'source-message', role: 'user', content: [{ type: 'text', text: entry.user_quote }],
      source: { kind, qq: { channel: 'direct', speaker: '哥哥', start: 0, length: entry.user_quote.length } },
    } }, { type: 'tool/call', data: { turn: 1, callId: 'album' } },
  ] } }, callId: 'album' });
  const save = tools.get('memory_album_save').execute;
  assert.equal((await save(entry, exec('schedule'))).id, undefined);
  assert.equal((await save({ ...entry, user_quote: '假的用户引言' }, exec('user'))).id, undefined);
  const result = await save(entry, exec('user'));
  assert.equal(result.created, true);
  const recalled = await tools.get('memory_album_search').execute({ query: '女仆装' });
  assert.equal(recalled.entries[0].source.messageId, 'source-message');
  assert.equal(recalled.entries[0].source.speaker, '哥哥');
  assert.equal(recalled.entries[0].user_quote, entry.user_quote);
  assert.equal((await save(entry, exec('user'))).created, false);
  assert.deepEqual(fs.readFileSync(memory.store.journalPath), before);
});
