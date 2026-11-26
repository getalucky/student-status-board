/**
 * 提示词（技术方案 §6.2 / §6.3）。集中管理，便于前端文案与后端一致。
 */
import { VOCABULARY } from './tags.js';
import { formatShanghaiDate, formatShanghaiDateTime } from './time.js';

/** 标签抽取：最近 10 条反馈 + 固定词表 → {"tags": [...]} */
export function buildTagMessages({ studentName, feedbacks, maxTags = 3 }) {
  const list = feedbacks
    .map((f, i) => `${i + 1}. [${formatShanghaiDateTime(f.happened_at)}] ${f.content}`)
    .join('\n');

  const system = [
    '你是一名严谨的学情分析助手，负责把老师日常记录的学生反馈归纳成固定的表现标签。',
    `只能从下面这份固定词表里选（共 ${VOCABULARY.length} 个）：${VOCABULARY.join('、')}。`,
    `最多选 ${maxTags} 个，宁少勿滥；只输出一个 JSON 对象，形如 {"tags":["标签1","标签2"]}，不要任何解释、不要代码块。`,
    '词表之外的词一律不要输出。',
  ].join('\n');

  const user = [
    `学生：${studentName || '未填写姓名'}`,
    '最近反馈（时间从早到晚）：',
    list || '（无）',
    '',
    `请综合上面这些反馈判断该生当前状态，从固定词表中选最多 ${maxTags} 个标签，输出 {"tags":[...]}。`,
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** 家长反馈生成：老师视角、面向家长、可直接复制、只依据区间内反馈 */
export function buildGenerateMessages({ studentName, school, range, feedbacks }) {
  const dateRange = `${formatShanghaiDate(range.from)} ~ ${formatShanghaiDate(range.to)}`;
  const list = feedbacks
    .map((f) => `- [${formatShanghaiDateTime(f.happened_at)}] ${f.content}`)
    .join('\n');

  const system = [
    '你是一位认真负责、说话实在的一线老师，正在给学生的家长写阶段反馈。',
    '要求：',
    '1. 以老师口吻、面向家长，用第二人称称呼家长（如「孩子最近…」），语气专业、温和、具体；',
    '2. 只依据给出的反馈记录归纳，不得编造记录里没有的事实、分数、事件或承诺；',
    '3. 结构：先总述这段时间的整体状态，再讲具体表现（可引用记录里的细节），最后给出 1~2 条可执行的建议；',
    '4. 篇幅 200~350 字，纯文本段落，不要小标题、不要 Markdown 符号、不要项目符号；',
    '5. 输出内容会被老师直接复制发给家长，因此不要出现「根据记录」「以下是」这类元话语，也不要在开头写称呼和落款。',
  ].join('\n');

  const user = [
    `学生姓名：${studentName || '未填写'}`,
    school ? `学校：${school}` : null,
    `参考时间范围：${dateRange}（共 ${range.weeks} 周）`,
    '这段时间老师记录的反馈：',
    list || '（无）',
    '',
    '请据此写出给家长的阶段反馈。',
  ]
    .filter(Boolean)
    .join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** /llm/test 用的极小请求 */
export function buildPingMessages() {
  return [
    { role: 'system', content: '你是一个连通性探针，只回一个字。' },
    { role: 'user', content: 'ping' },
  ];
}
