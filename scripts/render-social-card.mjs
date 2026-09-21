// Render the official vectors and self-hosted font without a browser or network.
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
if (!GlobalFonts.registerFromPath(fileURLToPath(new URL('landing/assets/brand/Manrope-Variable.ttf', root)), 'Manrope')) {
  throw new Error('Cannot load the brand font.');
}
const markSource = await readFile(new URL('brand/warden-mark.svg', root), 'utf8');
const mark = await loadImage(Buffer.from(markSource.replace('fill="currentColor"', 'fill="#f4f4f2"')));
const word = await loadImage(Buffer.from(await readFile(new URL('landing/assets/brand/warden-wordmark-light.svg', root))));
const output = new URL('landing/assets/share/', root);
await mkdir(output, { recursive: true });
for (const [name, lines, caption] of [
  ['warden-home-v3.png', ['Your AI.', 'Your rules.'], 'Free and open source.'],
  ['warden-guide-v3.png', ['You set', 'the rule.'], 'Describe. Review. Activate.'],
]) {
  const canvas = createCanvas(1200, 630);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#080808'; ctx.fillRect(0, 0, 1200, 630);
  const light = ctx.createRadialGradient(935, 315, 20, 935, 315, 520);
  light.addColorStop(0, '#1b1b1b'); light.addColorStop(1, '#080808');
  ctx.fillStyle = light; ctx.fillRect(0, 0, 1200, 630);
  ctx.drawImage(word, 72, 64, 164, 39);
  ctx.font = '600 92px Manrope'; ctx.letterSpacing = '-4px';
  ctx.fillStyle = '#aaa'; ctx.fillText(lines[0], 68, 284);
  ctx.fillStyle = '#f4f4f2'; ctx.fillText(lines[1], 68, 390);
  ctx.drawImage(mark, 766, 143, 358, 358);
  ctx.letterSpacing = '0px'; ctx.font = '400 22px Manrope'; ctx.fillStyle = '#aaa';
  ctx.fillText(caption, 72, 550);
  await writeFile(new URL(name, output), canvas.toBuffer('image/png'));
  console.log(`Rendered ${name} (1200 × 630)`);
}
