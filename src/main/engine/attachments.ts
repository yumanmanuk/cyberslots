/**
 * 附件发送共用助手 — 各引擎适配器的图片判定 / MIME / 读取。
 *
 * 格式白名单对齐 provider 地面真值（kimi image-format-policy + Anthropic /
 * OpenAI 文档）：仅 PNG/JPEG/GIF/WebP 可作为图片块发出。BMP/AVIF/HEIC 等
 * 一律退化为路径引用 —— 一张 provider 不支持的图会污染整段会话历史
 *（之后每轮请求都被 API 拒，kimi 称之为 session poisoning），
 * 宁可让引擎自己的 Read/view_image 工具去读，也绝不内联。
 */

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** 路径可按图片内联时返回其 MIME；否则 undefined（含 bmp 等不安全格式）。 */
export function inlineImageMime(path: string): string | undefined {
  return IMAGE_MIME_BY_EXT[extname(path).toLowerCase()];
}

export interface InlineImage {
  mediaType: string;
  /** base64 编码的图片字节。 */
  data: string;
}

/** 读图片文件为 base64；非白名单格式或读取失败（被删/无权限）返回
 *  undefined —— 调用方据此退化为路径引用，附件信息不丢。 */
export function readInlineImage(path: string): InlineImage | undefined {
  const mediaType = inlineImageMime(path);
  if (!mediaType) return undefined;
  try {
    return { mediaType, data: readFileSync(path).toString('base64') };
  } catch {
    return undefined;
  }
}

/** 读图片附件为可直接用于 <img src> 的 data URL；非图片或读取失败返回
 *  undefined（渲染层据此退化为文件 chip，附件信息不丢）。 */
export function inlineImageDataUrl(path: string): string | undefined {
  const img = readInlineImage(path);
  return img ? `data:${img.mediaType};base64,${img.data}` : undefined;
}

/** 文本类扩展名 — opencode file part 报 text/plain 时服务端走 Read
 *  工具把正文内联进上下文（bypassCwdCheck，工作区外可读），
 *  比「丢个路径让模型自己读」少一轮工具往返。 */
const TEXT_LIKE_EXT = new Set([
  '.txt', '.text', '.md', '.markdown', '.rst', '.log',
  '.json', '.jsonc', '.json5', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env',
  '.csv', '.tsv', '.xml', '.html', '.htm', '.css', '.scss', '.less',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
  '.py', '.pyi', '.rb', '.php', '.java', '.kt', '.kts', '.scala', '.go', '.rs',
  '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.cs', '.swift',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.psm1', '.bat', '.cmd',
  '.sql', '.lua', '.pl', '.r', '.dart', '.vue', '.svelte',
  '.graphql', '.gql', '.proto', '.zig', '.nim', '.jl',
  '.ex', '.exs', '.erl', '.hrl', '.clj', '.cljs', '.hs', '.ml', '.fs', '.fsx', '.vb',
  '.gitignore', '.gitattributes', '.editorconfig', '.dockerignore',
]);

export function isTextLikePath(path: string): boolean {
  return TEXT_LIKE_EXT.has(extname(path).toLowerCase());
}
