/**
 * 生成 OS 图标 resources/icon.png（256×256，零依赖：SDF 抗锯齿 + 手写 PNG 编码）。
 * 设计（黑金 Onyx 定稿，与 src/renderer/src/components/brand.tsx 同一图形语言）：
 * 深咖近黑底（顶光 + 暗角）+ 香槟金属金线稿拉杆老虎机 + 金色 keyline 内框；
 * 转轮窗内三颗 AI 星芒 ✦✦✦（= 三个 agent 同场开奖，呼应「多模型赛马」）。
 * 用法：node scripts/gen-icon.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const SIZE = 256;
const s = SIZE / 24;
const aa = 1 / s;
const clamp01 = (v) => Math.min(Math.max(v, 0), 1);
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function sdSegment(px, py, ax, ay, bx, by, r) {
  const dx = bx - ax, dy = by - ay;
  const t = clamp01(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t)) - r;
}
/** 四角星芒 ✦：iq rhombus SDF，竖横两枚细长菱形叠加 */
function sdRhombus(px, py, cx, cy, bw, bh) {
  const x = Math.abs(px - cx), y = Math.abs(py - cy);
  const h = Math.min(Math.max(((bw - 2 * x) * bw - (bh - 2 * y) * bh) / (bw * bw + bh * bh), -1), 1);
  const d = Math.hypot(x - 0.5 * bw * (1 - h), y - 0.5 * bh * (1 + h));
  return d * (x * bh + y * bw - bw * bh > 0 ? 1 : -1);
}
function sdSparkle(px, py, cx, cy, R) {
  return Math.min(sdRhombus(px, py, cx, cy, R * 0.38, R), sdRhombus(px, py, cx, cy, R, R * 0.38));
}
const tileDist = (x, y) => sdRoundRect(x, y, 12, 12, 11.45, 11.45, 5.4);

// ---- 黑金材质 ----
const GOLD_HI = [0xf6, 0xe2, 0xa4];
const GOLD_MID = [0xc9, 0x9d, 0x3f];
const GOLD_LO = [0x8f, 0x68, 0x1e];
const GOLD_SHEEN = [0xff, 0xf4, 0xcc];
/** 香槟金：纵向明暗 + 左上→右下高光扫带 */
function goldColor(x, y) {
  const t = clamp01((y - 3.5) / 17);
  let c = t < 0.5 ? mix(GOLD_HI, GOLD_MID, t * 2) : mix(GOLD_MID, GOLD_LO, (t - 0.5) * 2);
  const sheen = Math.exp(-((x + y - 18.5) ** 2) / 22) * 0.42;
  return mix(c, GOLD_SHEEN, sheen);
}

// ---- 图形几何（线稿拉杆老虎机，与 brand.tsx 一致） ----
const BODY = { cx: 10.6, cy: 12.3, hw: 5.6, hh: 6.2, r: 2.0 };
const WIN = { cx: 10.6, cy: 9.8, hw: 3.5, hh: 1.8, r: 0.9 };
function glyphDist(x, y) {
  const bodyStroke = Math.abs(sdRoundRect(x, y, BODY.cx, BODY.cy, BODY.hw, BODY.hh, BODY.r)) - 0.42;
  const winStroke = Math.abs(sdRoundRect(x, y, WIN.cx, WIN.cy, WIN.hw, WIN.hh, WIN.r)) - 0.3;
  let d = Math.min(bodyStroke, winStroke);
  // ✦✦✦：R 0.70 —— 比窗框留足空气感，避免顶满突兀
  for (const dx of [-2.0, 0, 2.0]) d = Math.min(d, sdSparkle(x, y, WIN.cx + dx, WIN.cy, 0.7));
  d = Math.min(d, sdSegment(x, y, 8.5, 16.1, 12.7, 16.1, 0.55)); // 出币槽
  d = Math.min(d, Math.hypot(x - 18.8, y - 6.5) - 1.2); // 拉杆球
  d = Math.min(d, sdSegment(x, y, 18.8, 7.6, 18.8, 12.3, 0.42)); // 拉杆
  d = Math.min(d, sdSegment(x, y, 16.2, 12.3, 18.8, 12.3, 0.42)); // 连接臂
  return d;
}
/** 星芒单独距离场：用于把星芒压暗一档与窗框融合 */
function sparkleDist(x, y) {
  let d = Infinity;
  for (const dx of [-2.0, 0, 2.0]) d = Math.min(d, sdSparkle(x, y, WIN.cx + dx, WIN.cy, 0.7));
  return d;
}
// 奢侈品包装内 keyline 框
const keylineDist = (x, y) => Math.abs(sdRoundRect(x, y, 12, 12, 9.95, 9.95, 4.5)) - 0.13;

function shade(x, y) {
  // 深咖底：顶部中心顶光，四角 vignette
  const lit = clamp01(Math.hypot(x - 12, y - 7) / 17);
  let c = mix([0x2b, 0x21, 0x18], [0x15, 0x0f, 0x0b], lit);
  // 左上对角一道极淡的斜面反光
  c = mix(c, [0x4a, 0x38, 0x28], 0.16 * Math.exp(-((x + y - 12) ** 2) / 30));
  const gd = glyphDist(x, y);
  const kd = keylineDist(x, y);
  // 金雾：图形周身极淡光晕，避免死黑
  c = mix(c, GOLD_MID, 0.1 * Math.exp(-Math.max(gd, 0) / 1.5));
  c = mix(c, goldColor(x, y), clamp01(0.5 - kd / aa) * 0.85);
  // 星芒取窗框同阶金色（融合），其余图形取本位金
  const spA = clamp01(0.5 - sparkleDist(x, y) / aa);
  const gold = mix(goldColor(x, y), goldColor(WIN.cx, WIN.cy + 1.2), spA * 0.75);
  return mix(c, gold, clamp01(0.5 - gd / aa));
}

// ---- PNG 编码 ----
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const rgba = Buffer.alloc(SIZE * SIZE * 4);
for (let py = 0; py < SIZE; py++) {
  for (let px = 0; px < SIZE; px++) {
    const x = (px + 0.5) / s;
    const y = (py + 0.5) / s;
    const c = shade(x, y);
    const i = (py * SIZE + px) * 4;
    rgba[i] = Math.round(clamp01(c[0] / 255) * 255);
    rgba[i + 1] = Math.round(clamp01(c[1] / 255) * 255);
    rgba[i + 2] = Math.round(clamp01(c[2] / 255) * 255);
    rgba[i + 3] = Math.round(clamp01(0.5 - tileDist(x, y) / aa) * 255);
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let row = 0; row < SIZE; row++) rgba.copy(raw, row * (SIZE * 4 + 1) + 1, row * SIZE * 4, (row + 1) * SIZE * 4);
writeFileSync(
  new URL('../resources/icon.png', import.meta.url),
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]),
);
console.log('written resources/icon.png (onyx & gold)');
