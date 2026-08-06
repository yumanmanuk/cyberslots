const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { NtExecutable, NtExecutableResource } = require('pe-library');
const ResEdit = require('resedit');

const ICON_SIZES = [16, 32, 48, 256];

function crcTable() {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
}
const CRC_TABLE = crcTable();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a valid PNG file');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (!width || !height || bitDepth !== 8 || colorType !== 6) {
    throw new Error('Only 8-bit RGBA PNG is supported; regenerate resources/icon.png with scripts/gen-icon.mjs');
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    if (raw[rowStart] !== 0) throw new Error('PNG row filter is not supported');
    raw.copy(rgba, y * stride, rowStart + 1, rowStart + 1 + stride);
  }
  return { width, height, rgba };
}

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

function resizeRgba(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const sx = (x + 0.5) * sw / dw - 0.5;
      const sy = (y + 0.5) * sh / dh - 0.5;
      const x0 = clamp(Math.floor(sx), 0, sw - 1);
      const y0 = clamp(Math.floor(sy), 0, sh - 1);
      const x1 = clamp(x0 + 1, 0, sw - 1);
      const y1 = clamp(y0 + 1, 0, sh - 1);
      const fx = clamp(sx - x0, 0, 1);
      const fy = clamp(sy - y0, 0, 1);
      const oi = (y * dw + x) * 4;
      for (let c = 0; c < 4; c++) {
        const a = src[(y0 * sw + x0) * 4 + c];
        const b = src[(y0 * sw + x1) * 4 + c];
        const d = src[(y1 * sw + x0) * 4 + c];
        const e = src[(y1 * sw + x1) * 4 + c];
        const top = a + (b - a) * fx;
        const bottom = d + (e - d) * fx;
        out[oi + c] = Math.round(top + (bottom - top) * fy);
      }
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function replaceWithRetry(tmpPath, targetPath) {
  const strategies = [
    () => fs.renameSync(tmpPath, targetPath),
    () => {
      fs.copyFileSync(tmpPath, targetPath);
      if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath);
    },
  ];
  let lastError;
  for (let attempt = 0; attempt < 15; attempt++) {
    for (const strategy of strategies) {
      try {
        strategy();
        return;
      } catch (error) {
        lastError = error;
      }
    }
    await sleep(1000);
  }
  throw lastError;
}

async function patchExeIcon(exePath, pngPath) {
  const png = decodePng(fs.readFileSync(pngPath));
  const items = ICON_SIZES.map((size) => {
    const resized = size === png.width ? png.rgba : resizeRgba(png.rgba, png.width, png.height, size, size);
    const pngBuf = encodePng(size, size, resized);
    return ResEdit.Data.RawIconItem.from(pngBuf, size, size, 32);
  });

  const exe = NtExecutable.from(fs.readFileSync(exePath));
  const res = NtExecutableResource.from(exe);
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  if (groups.length === 0) throw new Error('No icon resource found in exe');
  const target = groups[0];
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, target.id, target.lang, items);
  res.outputResource(exe);
  const newBinary = Buffer.from(exe.generate());
  const tmpPath = exePath + '.icon.tmp';
  fs.writeFileSync(tmpPath, newBinary);
  await replaceWithRetry(tmpPath, exePath);
  console.log('Patched exe icon: ' + exePath);
}

async function afterPack(context) {
  const exePath = path.join(context.appOutDir, 'CyberSlots.exe');
  const pngPath = path.resolve(__dirname, '..', 'resources', 'icon.png');
  if (!fs.existsSync(exePath)) throw new Error('missing exe: ' + exePath);
  if (!fs.existsSync(pngPath)) throw new Error('missing icon: ' + pngPath);
  await patchExeIcon(exePath, pngPath);
}

if (require.main === module) {
  const [exeArg, pngArg] = process.argv.slice(2);
  if (!exeArg) throw new Error('usage: node scripts/after-pack.cjs <exe> [png]');
  patchExeIcon(path.resolve(exeArg), path.resolve(pngArg || 'resources/icon.png')).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

exports.default = afterPack;
