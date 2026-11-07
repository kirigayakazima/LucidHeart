import { composeSheet, drawGlyphs, encodePngBuffer, fillRect } from '../../../../dsh-video-storyboard/src/storyboard/sheet.js';

const input = await new Promise((resolve, reject) => {
  const chunks = [];
  process.stdin.on('data', chunk => chunks.push(chunk));
  process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
  process.stdin.on('error', reject);
});
const split = input.indexOf(10);
const { cells, frames } = JSON.parse(input.subarray(0, split));
const grid = Math.sqrt(cells);
const size = 768;
const cell = size / grid;
let offset = split + 1;
const images = frames.map(([w, h]) => {
  const buffer = input.subarray(offset, offset + w * h * 3);
  offset += buffer.length;
  return { w, h, buffer };
});
const sheet = composeSheet({ frames: images, cols: grid, rows: grid, cellAspect: 1,
  gutter: 0, budget: size ** 2, burn: 'none' });
frames.forEach(([, , seconds], i) => {
  const ms = Math.floor(seconds * 1000);
  const timecode = [Math.floor(ms / 60000), Math.floor(ms / 1000) % 60, ms % 1000]
    .map((part, j) => String(part).padStart(j === 2 ? 3 : 2, '0')).join('-');
  const x = (i % grid + 1) * cell - timecode.length * 12 - 6;
  const y = (Math.floor(i / grid) + 1) * cell - 20;
  fillRect(sheet.buffer, size, size, x, y, timecode.length * 12 + 6, 20, [0, 0, 0], 0.85);
  drawGlyphs(sheet.buffer, size, size, timecode, x + 3, y + 3, 2, [255, 255, 255]);
});
process.stdout.write(await encodePngBuffer(sheet.buffer, size, size));
