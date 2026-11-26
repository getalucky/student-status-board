/**
 * 固定词表与模型输出校验（技术方案 §6.2）。
 * 词表唯一来源：shared/vocabulary.json（前后端共用一份）。
 *
 * 模型输出千奇百怪：纯 JSON、```json 代码块、带解释的 JSON、全角标点、
 * 直接给数组、纯文本列标签、项目符号/序号……这里统一做容错解析，
 * 最终仍只接受词表内的标签。
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../config.js';

const VOCAB_FILE = path.join(PROJECT_ROOT, 'shared', 'vocabulary.json');

function loadVocabulary() {
  const raw = JSON.parse(fs.readFileSync(VOCAB_FILE, 'utf8'));
  const flat = Array.isArray(raw.tags) ? raw.tags : [];
  const fromCategories = Array.isArray(raw.categories)
    ? raw.categories.flatMap((c) => (Array.isArray(c.tags) ? c.tags : []))
    : [];
  const tags = flat.length ? flat : fromCategories;
  const unique = [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))];
  return {
    tags: unique,
    maxPerStudent: Number.isInteger(raw.maxPerStudent) && raw.maxPerStudent > 0 ? raw.maxPerStudent : 3,
    categories: Array.isArray(raw.categories) ? raw.categories : [],
  };
}

const loaded = loadVocabulary();

/** 20 个固定标签（顺序即词表顺序） */
export const VOCABULARY = Object.freeze(loaded.tags);
export const VOCAB_SET = new Set(VOCABULARY);
export const MAX_TAGS = loaded.maxPerStudent;
export const VOCAB_CATEGORIES = Object.freeze(loaded.categories);

if (VOCABULARY.length !== 20) {
  // 词表被改坏时早点炸，别等标签校验静默失败
  throw new Error(`shared/vocabulary.json 词表应为 20 个，实际 ${VOCABULARY.length} 个`);
}

/** 文本里出现这么多个不同标签，基本可以判定模型在复读词表/提示词，不是真的在选标签 */
const ECHO_THRESHOLD = 10;

const WRAP_QUOTES = '"\'`“”‘’「」『』';
const LEADING_BULLETS = /^[\s\-*•·▪◦‣–—+]+/;
const LEADING_NUMBERING = /^(?:[（(]\d{1,2}[)）]|[【\[]\d{1,2}[】\]]|\d{1,2}\s*[.、)）:：]|[①-⑳])\s*/;

/**
 * 清理单个标签候选：去掉首尾空白、全/半角引号、项目符号、序号、顿号/逗号/句号等。
 * @param {unknown} value
 * @returns {string}
 */
export function cleanTagCandidate(value) {
  if (typeof value !== 'string') return '';
  let text = value.replace(/\u00A0/g, ' ').trim();

  const stripEdges = () => {
    // 首尾引号/反引号/书名号
    text = text.replace(new RegExp(`^[\\s${WRAP_QUOTES}]+|[\\s${WRAP_QUOTES}]+$`, 'g'), '');
    // 首尾顿号/逗号/句号等分隔符
    text = text.replace(/^[、,，.。;；:：\s]+|[、,，.。;；:：\s]+$/g, '');
  };

  stripEdges();

  // - / * / • / · / ▪ / ◦ 等项目符号（可能叠好几层）
  let prev;
  do {
    prev = text;
    text = text.replace(LEADING_BULLETS, '');
  } while (text !== prev);

  // 1. / 1、 / (1) / ① 等序号（可能叠好几层）
  do {
    prev = text;
    text = text.replace(LEADING_NUMBERING, '');
  } while (text !== prev);

  // 引号和分隔符可能互相包裹（例如 “进步明显”，），多剥几轮
  for (let i = 0; i < 3; i += 1) stripEdges();
  return text.trim();
}

/** 把 "进步明显、专注度高" / "1. 进步明显 2. 专注度高" 拆成候选 */
function splitTagString(value) {
  const cleaned = cleanTagCandidate(value);
  if (!cleaned) return [];
  if (VOCAB_SET.has(cleaned)) return [cleaned];
  return cleaned
    .split(/[、,，;；\n\r\t|/]+|\s+/)
    .map((part) => cleanTagCandidate(part))
    .filter(Boolean);
}

/**
 * 校验模型给出的标签：
 * - 词表外的丢弃
 * - 去重
 * - 超过 max 个（默认 3）截断
 * - tags 为空 ⇒ valid=false（调用方保留旧标签）
 * - 一次出现 >=10 个不同词表标签 ⇒ 视为复读词表，valid=false
 * @param {unknown} input
 * @param {{max?: number}} [opts]
 */
export function normalizeTags(input, opts = {}) {
  const max = Number.isInteger(opts.max) && opts.max > 0 ? opts.max : MAX_TAGS;
  const rawList = Array.isArray(input) ? input : typeof input === 'string' ? [input] : [];
  const candidates = [];

  for (const item of rawList) {
    if (typeof item === 'string') candidates.push(...splitTagString(item));
    else candidates.push(item);
  }

  const kept = [];
  const dropped = [];
  const seen = new Set();

  for (const item of candidates) {
    if (typeof item !== 'string') {
      dropped.push(String(item));
      continue;
    }
    const tag = cleanTagCandidate(item);
    if (!tag) continue;
    if (!VOCAB_SET.has(tag)) {
      dropped.push(tag);
      continue;
    }
    if (seen.has(tag)) continue;
    seen.add(tag);
    kept.push(tag);
  }

  // 模型复读整份词表时，别把前 3 个当成它选出来的标签
  if (seen.size >= ECHO_THRESHOLD) {
    return {
      tags: [],
      dropped,
      truncated: false,
      valid: false,
      echoedVocabulary: true,
    };
  }

  const tags = kept.slice(0, max);
  return {
    tags,
    dropped,
    truncated: kept.length > tags.length,
    valid: tags.length > 0,
  };
}

/** 全角标点转半角，让模型写成中文标点的 JSON 也能尽量 parse */
function relaxJsonSyntax(text) {
  return text
    .replace(/[“”‘’]/g, '"')
    .replace(/：/g, ':')
    .replace(/，/g, ',')
    .replace(/［/g, '[')
    .replace(/］/g, ']')
    .replace(/｛/g, '{')
    .replace(/｝/g, '}')
    .replace(/,\s*([\]}])/g, '$1'); // 尾逗号
}

/** @returns {unknown|undefined} undefined 表示 parse 失败 */
function tryParseJson(candidate) {
  for (const variant of [candidate, relaxJsonSyntax(candidate)]) {
    try {
      return JSON.parse(variant);
    } catch {
      // 试下一个
    }
  }
  return undefined;
}

/** 文本里是否出现了 >=10 个不同词表标签（模型复读词表/提示词的典型特征） */
export function isVocabularyEcho(text) {
  if (typeof text !== 'string' || !text) return false;
  let count = 0;
  for (const tag of VOCABULARY) {
    if (text.includes(tag)) {
      count += 1;
      if (count >= ECHO_THRESHOLD) return true;
    }
  }
  return false;
}

/** 在文本里按出现顺序找词表标签；>=10 个不同标签视为复读词表，返回 null */
function scanVocabularyTags(text) {
  if (typeof text !== 'string' || !text) return null;
  const haystack = text.replace(/^\uFEFF/, '');
  const hits = [];
  for (const tag of VOCABULARY) {
    const index = haystack.indexOf(tag);
    if (index >= 0) hits.push({ tag, index });
  }
  if (hits.length >= ECHO_THRESHOLD) return null;
  if (!hits.length) return null;
  hits.sort((a, b) => a.index - b.index);
  return hits.slice(0, MAX_TAGS).map((hit) => hit.tag);
}

/** 数组里的字符串可能是 "该生进步明显" 这种说明句，先扫词表再退回原文 */
function normalizeParsedList(list) {
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') {
      out.push(item);
      continue;
    }
    const scanned = scanVocabularyTags(item);
    if (scanned) out.push(...scanned);
    else out.push(item);
  }
  return out;
}

/** 从任意 JSON 值里挑标签：数组直接用；对象取第一个字符串数组字段，其次取字符串字段 */
function pickTagsFromParsed(parsed) {
  if (Array.isArray(parsed)) return normalizeParsedList(parsed);
  if (typeof parsed === 'string') {
    const scanned = scanVocabularyTags(parsed);
    return scanned ?? [parsed];
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const values = Object.values(parsed);
  for (const value of values) {
    if (Array.isArray(value) && value.some((item) => typeof item === 'string')) {
      return normalizeParsedList(value);
    }
  }
  for (const value of values) {
    if (typeof value === 'string') {
      const scanned = scanVocabularyTags(value);
      return scanned ?? [value];
    }
  }
  return null;
}

/** 生成 JSON 解析候选：原文、代码块、去围栏文本、首尾大括号/中括号切片、逐段括号 */
function buildJsonCandidates(text) {
  const out = [];
  const add = (value) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed) out.push(trimmed);
  };

  add(text);

  for (const match of text.matchAll(/```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/g)) {
    add(match[1]);
  }
  add(text.replace(/```[a-zA-Z0-9_-]*/g, '').replace(/```/g, ''));

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) add(text.slice(firstBrace, lastBrace + 1));
  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) add(text.slice(firstBracket, lastBracket + 1));

  for (const match of text.matchAll(/\{[\s\S]*?\}/g)) add(match[0]);
  for (const match of text.matchAll(/\[[\s\S]*?\]/g)) add(match[0]);

  return [...new Set(out)];
}

/**
 * 从模型输出里抠出标签候选。
 * 顺序：JSON（含代码块/带解释/全角标点）→ 纯文本扫描词表。
 * @param {string} text
 * @returns {unknown[]|null}
 */
export function extractTagArray(text) {
  if (typeof text !== 'string') return null;
  const raw = text.replace(/^\uFEFF/, '').trim();
  if (!raw) return null;

  let parsedSomething = false;
  for (const candidate of buildJsonCandidates(raw)) {
    const parsed = tryParseJson(candidate);
    if (parsed === undefined) continue;
    parsedSomething = true;
    const picked = pickTagsFromParsed(parsed);
    if (picked) return picked;
  }

  // 已经成功 parse 出 JSON，只是里面没有标签字段：按无效处理，不再去文本里乱抓
  if (parsedSomething) return null;

  // JSON 解析失败：纯文本兜底（复读词表由 scanVocabularyTags 直接判 null）
  return scanVocabularyTags(raw);
}
