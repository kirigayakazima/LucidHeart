const echoGain = 10 ** (-36 / 20)

export function matchesPlayback(mic, reference, offset, { active = true, route = 'speaker' } = {}) {
  if (!active || route === 'headphone' || !reference || offset < 0) return false
  let micPower = 0
  for (let i = 0; i < mic.length; i += 4) micPower += mic[i] ** 2
  if (micPower < .002) return false
  for (let lag = 0; lag <= 4000; lag += 8) {
    const start = offset - lag
    if (start < 0 || start + mic.length > reference.length) continue
    let cross = 0
    let power = 0
    for (let i = 0; i < mic.length; i += 4) {
      const value = reference[start + i]
      cross += mic[i] * value
      power += value * value
    }
    if (power > .002 && micPower < 4 * power && Math.abs(cross) > .65 * Math.sqrt(micPower * power)) return true
  }
  return false
}

export function guardEcho(mic, reference, offset, options) {
  const echo = matchesPlayback(mic, reference, offset, options)
  return { echo, samples: echo ? mic.map(value => value * echoGain) : mic }
}
