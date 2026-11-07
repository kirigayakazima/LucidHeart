// The hardware/browser AEC runs first. This check suppresses strongly correlated
// residual speaker audio, using the same AudioContext clock as the microphone.
export function matchesPlayback(mic, reference, offset) {
  let micPower = 0;
  for (let i = 0; i < mic.length; i += 4) micPower += mic[i] ** 2;
  if (micPower < 0.002 || offset < 0) return false;
  for (let lag = 0; lag <= 4000; lag += 8) {
    const start = offset - lag;
    if (start < 0 || start + mic.length > reference.length) continue;
    let cross = 0;
    let power = 0;
    for (let i = 0; i < mic.length; i += 4) {
      const sample = reference[start + i];
      cross += mic[i] * sample;
      power += sample * sample;
    }
    if (power > 0.002 && Math.abs(cross) > 0.78 * Math.sqrt(micPower * power)) return true;
  }
  return false;
}
