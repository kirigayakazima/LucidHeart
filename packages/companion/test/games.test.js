import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startTwenty, targetDigest, twentyAction } from '../lib/activity/twenty_questions.js'
import { idiomAction, startIdiom } from '../lib/activity/idiom_chain.js'
import { host } from './fixture.js'

test('twenty questions stores salted commitments without the answer and rejects false reveals', () => {
  const salt = 'a'.repeat(32)
  const state = startTwenty({ target_category: '动物', target_hash: targetDigest('鲸鱼', salt), salt })
  assert.ok(!JSON.stringify(state).includes('鲸鱼'))
  assert.notEqual(state.target_hash, targetDigest('鲸鱼', 'b'.repeat(32)))
  assert.throws(() => twentyAction(state, { action: 'surrender', input: '海豚' }), /原承诺/)
  assert.equal(twentyAction(state, { action: 'guess', guess: '鲸鱼' }).done, true)
})

test('twenty questions enforces valid answers, one pending question and a 20-question limit', () => {
  let state = startTwenty({ target_category: '动物', target: '猫' })
  for (let index = 0; index < 20; index++) {
    state = twentyAction(state, { action: 'ask', input: '是动物吗' }).state
    assert.throws(() => twentyAction(state, { action: 'ask', input: '下一问' }))
    assert.throws(() => twentyAction(state, { action: 'answer', input: '也许' }))
    state = twentyAction(state, { action: 'answer', input: '是' }).state
  }
  assert.equal(state.remaining_guesses, 0)
  assert.throws(() => twentyAction(state, { action: 'guess', guess: '猫' }))
  assert.equal(twentyAction(state, { action: 'reveal', input: '猫' }).done, true)
})

test('idiom chain validates words and homophones, scores both sides and gives unused hints', () => {
  let state = startIdiom({ current_word: '大功告成' })
  assert.ok(idiomAction(state, { action: 'hint' }).feedback.hints.length)
  state = idiomAction(state, { action: 'answer', input: '程门立雪' }).state
  state = idiomAction(state, { action: 'answer', input: '雪中送炭' }).state
  assert.deepEqual([state.player_score, state.xiaoman_score], [1, 1])
  assert.throws(() => idiomAction(state, { action: 'answer', input: '大功告成' }), /已经使用/)
  assert.throws(() => idiomAction(state, { action: 'answer', input: '假的成语' }), /词库/)
  assert.equal(idiomAction(state, { action: 'surrender' }).done, true)
})

test('generic activity step and finish cannot replace or bypass the game commitment', async t => {
  const h = host(t)
  const { data } = await h.run('activity_start', { type: 'game', title: '二十问',
    initial_state: { game: 'twenty_questions', target_category: '动物', target: '猫' } })
  assert.equal((await h.run('activity_step', { id: data.id, delta_state: { target_hash: 'fake' }, action_summary: '替换' })).ok, false)
  assert.equal((await h.run('activity_finish', { id: data.id, summary: '强行完成' })).ok, false)
  assert.equal((await h.run('game_action', { action: 'guess', guess: '猫' })).data.status, 'completed')
})
