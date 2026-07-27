// 一次性脚本：把手动下载的 Electron zip 放入 @electron/get 全局缓存
const fs = require('fs');
const path = require('path');
const { Cache } = require('@electron/get/dist/cjs/Cache.js');

const version = '33.4.11';
const files = ['electron-v' + version + '-win32-x64.zip', 'SHASUMS256.txt'];

const bases = [
  // 官方源（默认无镜像时使用）
  `https://github.com/electron/electron/releases/download/v${version}/`,
  // npmmirror 镜像（ELECTRON_MIRROR / .npmrc 配置时使用）
  `https://npmmirror.com/mirrors/electron/v${version}/`,
  `https://npmmirror.com/mirrors/electron/${version}/`,
];

const cache = new Cache();
for (const fileName of files) {
  const src = path.resolve(__dirname, '..', fileName);
  for (const base of bases) {
    const dest = cache.getCachePath(base + fileName, fileName);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    console.log('cached:', dest);
  }
}
