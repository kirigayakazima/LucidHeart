import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractInitialState, imageUrl, noteUrl, parseNote } from '../lib/parser.js'

const id = '67de21b90000000012009abc'

test('reads requested note text, tags, interactions and ranked image URLs', () => {
  const note = { title: '窗边', desc: '好天气 } \\ "', user: { nickname: '小舟' }, tagList: [{ name: '生活' }],
    interactInfo: { likedCount: '1.2万', collectedCount: 3 }, imageList: [
      { infoList: [{ imageScene: 'WB_DFT', url: 'https://sns-webpic-qc.xhscdn.com/high.webp' }], url: 'https://x.xhscdn.com/lower.png' },
      { urlDefault: 'https://x.xhscdn.com/second.jpg' }, { url: 'https://private.example/p.jpg' },
    ] }
  const state = { note: { noteDetailMap: { [id]: { note }, other: { note: { title: '另一篇' } } } } }
  const actual = parseNote(`<script>window.__INITIAL_STATE__=${JSON.stringify(state)};alert(1)</script>`, id)
  assert.deepEqual(actual, { id, title: note.title, desc: note.desc, author: '小舟', tags: ['生活'], likes: '1.2万', saves: 3,
    images: ['https://sns-webpic-qc.xhscdn.com/high.webp', 'https://x.xhscdn.com/second.jpg'] })
})

test('normalizes bare undefined without changing quoted values', () => {
  assert.deepEqual(extractInitialState('<script>window.__INITIAL_STATE__={"a":undefined,"x":[undefined,"undefined"]}</script>'),
    { a: null, x: [null, 'undefined'] })
})

test('refuses executable assignments and empty note maps', () => {
  assert.equal(extractInitialState('<script>window.__INITIAL_STATE__={"x":(()=>42)()}</script>'), null)
  assert.equal(parseNote('<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{}}}</script>', id), null)
})

test('holds note and image URLs to distinct HTTPS allowlists', () => {
  assert.equal(noteUrl(`https://www.xiaohongshu.com/discovery/item/${id}?xsec_token=t`).id, id)
  assert.equal(noteUrl('https://xhslink.com/a/abc').short, true)
  for (const value of [`http://www.xiaohongshu.com/explore/${id}`, `https://www.xiaohongshu.com.bad.test/explore/${id}`,
    `https://user@xiaohongshu.com/explore/${id}`, 'https://127.0.0.1/a/abc', 'https://xhslink.com:8080/a/abc']) assert.equal(noteUrl(value), null)
  assert.equal(imageUrl('https://evil.test/x.xhscdn.com'), null)
  assert.equal(imageUrl('https://x.xhscdn.com.evil.test/a'), null)
})
