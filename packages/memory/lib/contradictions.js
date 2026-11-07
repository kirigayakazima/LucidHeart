const kinds = ['fact', 'preference'];
const owner = '(?<owner>[\\p{L}\\p{N}_·]{0,12}?)(?<temporal>(?:现在|最近|以前|原本|之前|曾经|目前|已经|平时|通常|每天|一般)*)';
const statement = (pattern) => new RegExp(`^${owner}${pattern}$`, 'u');
const avoidSpice = statement('(?:戒辣|不(?:再|能|要)?吃辣|不喜欢吃辣|一点辣都不能吃)了?(?:[,，]一点辣都不能吃)?');
const eatSpice = statement('(?:喜欢|爱|偏好|能)(?:吃)?(?:微|少|中|重|特|一点)?辣(?:的食物)?');
const address = statement('(?:住在|居住在|常住(?:地(?:是|为|改为))?|(?:的)?住址(?:是|在|为|改为)|(?:从[^，,。 ]+)?搬(?:家)?(?:到|去))(?<value>[\\p{L}\\p{N}]{1,24}?)了?');
const routine = statement('(?<period>凌晨|早上|上午|中午|下午|傍晚|晚上|半夜)?(?<hour>[0-9]{1,2}|[零一二两三四五六七八九十]{1,3})(?:(?:点|时)(?:(?<half>半)|(?<minutes>[0-9]{1,2})分?)?|:(?<clock>[0-9]{2}))(?<activity>睡觉|入睡|睡|起床)');
const favorite = statement('最喜欢的(?<topic>[\\p{L}]{1,12})(?:是|为|改为)(?<value>[\\p{L}\\p{N} ]{1,32})');
const liking = statement('(?<attitude>不再喜欢|不喜欢|讨厌|喜欢|爱)(?:吃|喝)?(?<value>[\\p{L}\\p{N} ]{1,32}?)了?');

function describe(text) {
  text = text.normalize('NFKC').trim().replace(/[。.!！]+$/, '');
  const identify = (match, dimension, value, query = dimension) => ({
    owner: /^(?:我|用户|主人|本人)$/.test(match.groups.owner) ? '' : match.groups.owner,
    historic: /以前|原本|之前|曾经/.test(match.groups.temporal),
    dimension, value, query,
  });
  let match = text.match(avoidSpice);
  if (match) return identify(match, '辣', 'avoid');
  match = text.match(eatSpice);
  if (match) return identify(match, '辣', 'eat');
  match = text.match(address);
  if (match && !/但是|并且|同时|有时/.test(match.groups.value)) {
    return identify(match, '住址', match.groups.value, '住在 住址 常住 搬到 搬家 搬去');
  }
  match = text.match(routine);
  if (match) {
    const { period, hour, minutes, clock, half, activity } = match.groups;
    const digit = (char) => '零一二三四五六七八九'.indexOf(char?.replace('两', '二'));
    const [tens, units] = hour.split('十');
    let h = /^\d+$/.test(hour) ? Number(hour) : units === undefined
      ? digit(hour) : (tens ? digit(tens) : 1) * 10 + (units ? digit(units) : 0);
    const m = half ? 30 : Number(minutes || clock || 0);
    if (h < 0 || h > 23 || m > 59) return;
    if (/^(下午|傍晚|晚上)$/.test(period) && h < 12) h += 12;
    if (/^(凌晨|半夜)$/.test(period) && h === 12) h = 0;
    return activity === '起床'
      ? identify(match, '起床', h * 60 + m)
      : identify(match, '入睡', h * 60 + m, '睡觉 入睡 点睡');
  }
  match = text.match(favorite);
  if (match) return identify(match, `最喜欢的${match.groups.topic}`, match.groups.value, match.groups.topic);
  match = text.match(liking);
  if (match) return identify(match, `喜好:${match.groups.value}`, /^(喜欢|爱)$/.test(match.groups.attitude), match.groups.value);
}

export function findContradictions(entry, indexer) {
  if (!kinds.includes(entry.kind) || entry.status !== 'active' || entry.provenance?.origin !== 'user_statement') return [];
  const next = describe(entry.content);
  if (!next || next.historic) return [];
  const { speaker, channel } = entry.provenance;
  const subject = next.owner || speaker;

  return indexer.search(next.query, { scope: entry.scope, exactScope: true, kind: kinds, limit: 3 }).filter((old) => {
    if (old.provenance && old.provenance.speaker !== speaker) return false;
    const previous = describe(old.content);
    const previousSubject = previous?.owner || old.provenance?.speaker || (channel === 'direct' ? speaker : '');
    return previous?.dimension === next.dimension && previousSubject === subject && previous.value !== next.value;
  });
}
