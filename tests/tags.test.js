import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TAGS,
  VOCABULARY,
  cleanTagCandidate,
  extractTagArray,
  normalizeTags,
} from '../server/lib/tags.js';

function tagsOf(text) {
  return normalizeTags(extractTagArray(text) ?? []).tags;
}

test('纯文本：进步明显、专注度高', () => {
  assert.deepEqual(tagsOf('进步明显、专注度高'), ['进步明显', '专注度高']);
  assert.deepEqual(tagsOf('本次表现：专注度高，进步明显。'), ['专注度高', '进步明显']);
});

test('JSON 字符串本身也能当标签', () => {
  assert.deepEqual(tagsOf('"进步明显"'), ['进步明显']);
  assert.deepEqual(tagsOf('"进步明显、专注度高"'), ['进步明显', '专注度高']);
});

test('带解释的 JSON：取第一个字符串数组字段', () => {
  const text = '分析如下：\n{"tags":["状态稳定","作业认真"]}\n以上，供参考。';
  assert.deepEqual(tagsOf(text), ['状态稳定', '作业认真']);
});

test('```json 代码块（带前后解释）', () => {
  const text = '结果：\n```json\n{"tags": ["思维活跃", "配合度高"]}\n```\n希望有帮助。';
  assert.deepEqual(tagsOf(text), ['思维活跃', '配合度高']);
});

test('全角引号/全角标点的 JSON', () => {
  assert.deepEqual(tagsOf('{“tags”：[“进步明显”，“专注度高”]}'), ['进步明显', '专注度高']);
});

test('对象非标准 key：任意第一个字符串数组字段都接受', () => {
  assert.deepEqual(tagsOf('{"analysis":"最近不错","labels":["理解力强"]}'), ['理解力强']);
  assert.deepEqual(tagsOf('{"result":["基础薄弱"],"note":"继续观察"}'), ['基础薄弱']);
});

test('对象字段值是字符串：也接受（按分隔符拆）', () => {
  assert.deepEqual(tagsOf('{"tags":"进步明显、专注度高"}'), ['进步明显', '专注度高']);
  assert.deepEqual(tagsOf('{"label":"状态稳定"}'), ['状态稳定']);
});

test('项目符号 / 序号 / 全角引号清理', () => {
  assert.equal(cleanTagCandidate('  1. “进步明显”， '), '进步明显');
  assert.equal(cleanTagCandidate('• 专注度高。'), '专注度高');
  assert.equal(cleanTagCandidate('（2）「作业认真」'), '作业认真');
  assert.deepEqual(tagsOf('["1. 进步明显", "• 专注度高", "- 作业认真"]'), [
    '进步明显',
    '专注度高',
    '作业认真',
  ]);
});

test('数组里是说明句：先扫词表', () => {
  assert.deepEqual(tagsOf('["该生进步明显，课堂上专注度高"]'), ['进步明显', '专注度高']);
});

test('模型复读完整词表：直接判无效', () => {
  const echoed = VOCABULARY.join('、');
  assert.equal(extractTagArray(echoed), null, '纯文本复读应视为无效');
  const result = normalizeTags(VOCABULARY);
  assert.equal(result.valid, false);
  assert.equal(result.echoedVocabulary, true);
  assert.deepEqual(result.tags, []);

  // JSON 里塞满 20 个标签也不能截前 3 个当成有效
  const fromJson = normalizeTags(extractTagArray(JSON.stringify({ tags: VOCABULARY })) ?? []);
  assert.equal(fromJson.valid, false);
  assert.equal(fromJson.echoedVocabulary, true);
});

test('词表外标签丢弃、最多 3 个', () => {
  const result = normalizeTags(['状态稳定', '瞎编标签', '专注度高', '进步明显', '积极性高']);
  assert.deepEqual(result.tags, ['状态稳定', '专注度高', '进步明显']);
  assert.equal(result.dropped.includes('瞎编标签'), true);
  assert.equal(result.truncated, true);
  assert.equal(MAX_TAGS, 3);
});

test('没有可识别标签：null / invalid', () => {
  assert.equal(extractTagArray('抱歉，我无法判断。'), null);
  // 对象里只有普通字符串字段：提取得到原文，但校验必须判无效
  assert.equal(normalizeTags(extractTagArray('{"note":"没有结论"}') ?? []).valid, false);
  assert.equal(normalizeTags([]).valid, false);
  assert.equal(normalizeTags(['完全无关']).valid, false);
});
