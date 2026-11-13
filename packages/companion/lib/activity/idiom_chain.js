import { requireThat, str } from '../db.js'

// Curated word endpoints in tone-free pinyin, including the reading in context.
const words = new Map(Object.entries({
  一心一意: ['yi', 'yi'], 意气风发: ['yi', 'fa'], 发扬光大: ['fa', 'da'], 大功告成: ['da', 'cheng'],
  成人之美: ['cheng', 'mei'], 美不胜收: ['mei', 'shou'], 收放自如: ['shou', 'ru'], 如鱼得水: ['ru', 'shui'],
  水到渠成: ['shui', 'cheng'], 成千上万: ['cheng', 'wan'], 万众一心: ['wan', 'xin'], 心想事成: ['xin', 'cheng'],
  程门立雪: ['cheng', 'xue'], 雪中送炭: ['xue', 'tan'], 探囊取物: ['tan', 'wu'], 物归原主: ['wu', 'zhu'],
  主次分明: ['zhu', 'ming'], 明日黄花: ['ming', 'hua'], 花好月圆: ['hua', 'yuan'], 圆木警枕: ['yuan', 'zhen'],
  真心实意: ['zhen', 'yi'], 一帆风顺: ['yi', 'shun'], 顺水推舟: ['shun', 'zhou'], 舟车劳顿: ['zhou', 'dun'],
  顿开茅塞: ['dun', 'se'], 塞翁失马: ['sai', 'ma'], 马到成功: ['ma', 'gong'], 功德圆满: ['gong', 'man'],
  满载而归: ['man', 'gui'], 归心似箭: ['gui', 'jian'], 见多识广: ['jian', 'guang'], 广开言路: ['guang', 'lu'],
  路不拾遗: ['lu', 'yi'], 遗世独立: ['yi', 'li'], 立竿见影: ['li', 'ying'], 影影绰绰: ['ying', 'chuo'],
  青山绿水: ['qing', 'shui'], 水落石出: ['shui', 'chu'], 出人头地: ['chu', 'di'], 地久天长: ['di', 'chang'],
  长驱直入: ['chang', 'ru'], 入木三分: ['ru', 'fen'], 分秒必争: ['fen', 'zheng'], 争先恐后: ['zheng', 'hou'],
  后起之秀: ['hou', 'xiu'], 秀外慧中: ['xiu', 'zhong'], 中流砥柱: ['zhong', 'zhu'], 柱石之坚: ['zhu', 'jian'],
  坚持不懈: ['jian', 'xie'], 谢天谢地: ['xie', 'di'], 天高云淡: ['tian', 'dan'], 淡泊明志: ['dan', 'zhi'],
  志同道合: ['zhi', 'he'], 合情合理: ['he', 'li'], 理直气壮: ['li', 'zhuang'], 壮志凌云: ['zhuang', 'yun'],
}))

export function startIdiom({ current_word = '一心一意', allow_homophones = true }) {
  requireThat(words.has(current_word) && typeof allow_homophones === 'boolean', '起始成语或同音规则无效')
  return { game: 'idiom_chain', history: [current_word], current_word, turn_count: 0,
    player_score: 0, xiaoman_score: 0, next_player: 'user', allow_homophones }
}

function connects(state, next) {
  const previous = state.current_word
  return !state.history.includes(next) && (previous.at(-1) === next[0] ||
    (state.allow_homophones && words.get(previous)[1] === words.get(next)[0]))
}

export function idiomAction(state, { action, input }) {
  if (action === 'hint') {
    const hints = [...words.keys()].filter(word => connects(state, word)).slice(0, 3)
    return { state, feedback: { hints } }
  }
  if (action === 'surrender') return { state: { ...state, surrendered_by: state.next_player },
    done: true, feedback: '本局结束，已保留双方得分。' }
  requireThat(action === 'answer', '接龙请使用 answer、hint 或 surrender')
  const word = str(input, '成语', 12)
  requireThat(words.has(word), '该成语不在本地校验词库')
  requireThat(!state.history.includes(word), '成语已经使用')
  requireThat(connects(state, word), '首字或拼音未接上')
  const score = state.next_player === 'user' ? 'player_score' : 'xiaoman_score'
  return { state: { ...state, history: [...state.history, word], current_word: word,
    turn_count: state.turn_count + 1, [score]: state[score] + 1,
    next_player: state.next_player === 'user' ? 'xiaoman' : 'user' }, feedback: '接龙成功' }
}
