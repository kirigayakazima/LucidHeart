import { createHash, randomBytes } from 'node:crypto'
import { requireThat, str } from '../db.js'

const answers = ['是', '不是', '不确定', '算吧']
const normalized = text => str(text, '题目').normalize('NFKC').toLowerCase()
export const targetDigest = (target, salt) =>
  createHash('sha256').update(JSON.stringify([salt, normalized(target)])).digest('hex')

export function startTwenty({ target_category, target, salt = randomBytes(16).toString('hex'), target_hash }) {
  requireThat(typeof salt === 'string' && /^[a-f0-9]{32,128}$/i.test(salt), '需要至少 128 位十六进制盐')
  const hash = target === undefined ? target_hash : targetDigest(target, salt)
  requireThat(typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash), '需要 SHA-256 题目承诺')
  requireThat(!target_hash || target_hash === hash, '题目与承诺不符')
  return { game: 'twenty_questions', target_category: str(target_category, 'target_category'), target_hash: hash,
    salt, questions: [], remaining_guesses: 20, guessed_correctly: false }
}

export function twentyAction(state, { action, input, guess }) {
  const pending = state.questions.at(-1)?.a === null
  const exhausted = state.remaining_guesses === 0 && !pending
  requireThat(!state.awaiting_reveal || ['reveal', 'surrender', 'hint'].includes(action), '已认输，请先揭晓题目')
  if (action === 'hint') return { state, feedback: exhausted ? '问题已用完，请揭晓并验证题目。' : state.target_category }
  if (action === 'ask') {
    requireThat(!pending && state.remaining_guesses > 0, '请先回答上一问，或已用完二十问')
    const questions = [...state.questions, { q: str(input, '问题'), a: null, round: state.questions.length + 1 }]
    return { state: { ...state, questions, remaining_guesses: 20 - questions.length }, feedback: '请定题方回答。' }
  }
  if (action === 'answer') {
    requireThat(pending && answers.includes(input), '只能对待答问题回复：是、不是、不确定、算吧')
    const questions = state.questions.map((q, i) => i === state.questions.length - 1 ? { ...q, a: input } : q)
    return { state: { ...state, questions }, feedback: state.remaining_guesses ? input : '二十问已用完，请揭晓题目。' }
  }
  if (action === 'guess') {
    requireThat(!pending && !exhausted, '请先回答，或在用完二十问后揭晓题目')
    const text = str(guess, '最终猜测')
    const correct = targetDigest(text, state.salt) === state.target_hash
    return { state: { ...state, guessed_correctly: correct, final_guess: text, ...(correct && { revealed_target: text }) },
      done: correct, feedback: correct ? '猜对了，SHA-256 承诺校验通过。' : '猜测与题目承诺不符，可继续提问。' }
  }
  requireThat(action === 'surrender' || action === 'reveal', '未知二十问操作')
  if (action === 'surrender' && input === undefined) {
    return { state: { ...state, awaiting_reveal: true }, feedback: '已认输，请定题方揭晓并验证题目。' }
  }
  requireThat(exhausted || state.awaiting_reveal || action === 'surrender', '仅在认输或二十问用完后揭晓')
  const text = str(input, '揭晓题目')
  requireThat(targetDigest(text, state.salt) === state.target_hash, '揭晓内容与原承诺不符')
  return { state: { ...state, revealed_target: text }, done: true, feedback: '揭晓通过 SHA-256 承诺校验。' }
}
