import test from 'node:test';
import assert from 'node:assert/strict';
import {
  endOfWeek,
  formatShanghaiDate,
  parseHappenedAt,
  shanghaiWeekday,
  startOfWeek,
  weekRange,
} from '../server/lib/time.js';

const at = (iso) => Date.parse(iso);

test('周切分：Asia/Shanghai 周一为起点（2026-11-25 是周三）', () => {
  const now = at('2026-11-25T20:12:11+08:00');
  assert.equal(shanghaiWeekday(now), 3);
  assert.equal(startOfWeek(now), at('2026-11-23T00:00:00+08:00'));
  assert.equal(endOfWeek(now), at('2026-11-29T23:59:59.999+08:00'));

  // 周一 00:00 整属于新的一周
  assert.equal(startOfWeek(at('2026-11-23T00:00:00+08:00')), at('2026-11-23T00:00:00+08:00'));
  // 周日 23:59:59.999 仍属于本周
  assert.equal(startOfWeek(at('2026-11-29T23:59:59.999+08:00')), at('2026-11-23T00:00:00+08:00'));
  // 周一前一毫秒是上周
  assert.equal(startOfWeek(at('2026-11-22T23:59:59.999+08:00')), at('2026-11-16T00:00:00+08:00'));
});

test('weekRange：1 周 = 本周一~本周日；N 周往前推 N-1 周', () => {
  const now = at('2026-11-25T20:12:11+08:00');
  const one = weekRange(1, now);
  assert.equal(one.from, at('2026-11-23T00:00:00+08:00'));
  assert.equal(one.to, at('2026-11-29T23:59:59.999+08:00'));

  const four = weekRange(4, now);
  assert.equal(four.from, at('2026-11-02T00:00:00+08:00'));
  assert.equal(four.to, one.to);

  const twenty = weekRange(20, now);
  assert.equal(twenty.from, at('2026-07-13T00:00:00+08:00'));
});

test('weekRange：weeks 越界/非整数直接抛 400', () => {
  for (const bad of [0, 21, -1, 1.5, Number.NaN]) {
    assert.throws(() => weekRange(bad, Date.now()), (err) => err.statusCode === 400, `weeks=${bad}`);
  }
});

test('跨时区正确性：UTC 周日 16:00 = 上海周一 00:00', () => {
  // 2026-11-22T16:00:00Z = 2026-11-23 00:00 +08:00
  const ts = Date.parse('2026-11-22T16:00:00Z');
  assert.equal(shanghaiWeekday(ts), 1);
  assert.equal(startOfWeek(ts), ts);
});

test('formatShanghaiDate 用上海日期，不受进程时区影响', () => {
  assert.equal(formatShanghaiDate(at('2026-11-29T23:59:59.999+08:00')), '2026-11-29');
  assert.equal(formatShanghaiDate(at('2026-11-22T16:00:00Z')), '2026-11-23');
});

test('parseHappenedAt：毫秒 / 秒 / ISO / 缺省', () => {
  const now = 1_800_000_000_000;
  assert.equal(parseHappenedAt(undefined, now), now);
  assert.equal(parseHappenedAt(1_700_000_000_000, now), 1_700_000_000_000);
  assert.equal(parseHappenedAt('1700000000', now), 1_700_000_000_000);
  assert.equal(parseHappenedAt('2026-11-25T10:00:00+08:00', now), at('2026-11-25T10:00:00+08:00'));
  assert.throws(() => parseHappenedAt('不是时间', now), (err) => err.statusCode === 400);
});
