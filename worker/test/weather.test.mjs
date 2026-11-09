// node test/weather.test.mjs  — 격자 변환·발표시각·응답 정리 검사 (네트워크·인증키 필요 없음)
import assert from 'node:assert/strict';
import { toGrid } from '../src/grid.js';
import { fcstBase, ncstBase } from '../src/time.js';
import { parseFcst, parseNcst, parseMet, combine } from '../src/index.js';

// 격자 변환
const cases = [['서울시청', 37.5665, 126.978, 60, 127], ['굴업도(근처)', 37.19, 125.99, 0, 0]];
for (const [n, la, lo, x, y] of cases) { const g = toGrid(la, lo); console.log(n, la, lo, '→', g.nx, g.ny); if (x === 60) assert.deepEqual(g, { nx: x, ny: y }); }

// 발표시각 (KST = UTC+9, 입력은 UTC 밀리초)
const at = (h, m, d = 9) => Date.UTC(2026, 10, d, h - 9, m);
assert.deepEqual(fcstBase(at(14, 9)), { date: '20261109', time: '1100' });   // 14:09 → 아직 11시 발표
assert.deepEqual(fcstBase(at(14, 10)), { date: '20261109', time: '1400' });  // 14:10 → 14시 발표
assert.deepEqual(fcstBase(at(1, 30)), { date: '20261108', time: '2300' });   // 02:10 전 → 어제 23시
assert.deepEqual(fcstBase(at(2, 10)), { date: '20261109', time: '0200' });
assert.deepEqual(ncstBase(at(14, 39)), { date: '20261109', time: '1300' });  // 40분 전 → 한 시간 전
assert.deepEqual(ncstBase(at(14, 40)), { date: '20261109', time: '1400' });
assert.deepEqual(ncstBase(at(0, 10)), { date: '20261108', time: '2300' });   // 자정 넘김

// 단기예보 정리
const mk = (c, d, t, v) => ({ category: c, fcstDate: d, fcstTime: t, fcstValue: v });
const fc = parseFcst([mk('TMP', '20261110', '1500', '12'), mk('POP', '20261110', '1500', '30'), mk('PTY', '20261110', '1500', '1'), mk('PCP', '20261110', '1500', '1.0mm'),
  mk('SKY', '20261110', '1500', '4'), mk('WSD', '20261110', '1500', '3.4'), mk('TMN', '20261110', '0600', '-1.0'), mk('TMX', '20261110', '1500', '12.0'), mk('XXX', '20261110', '1500', '9')]);
assert.equal(fc.hours['2026-11-10T15:00'].t, 12); assert.equal(fc.hours['2026-11-10T15:00'].pcp, '1.0mm'); assert.equal(fc.tmn['2026-11-10'], -1); assert.equal(Object.keys(fc.hours).length, 1);
// 실황
const nc = parseNcst([{ category: 'T1H', obsrValue: '17.2' }, { category: 'WSD', obsrValue: '2.1' }, { category: 'PTY', obsrValue: '0' }, { category: 'RN1', obsrValue: '0' }], { time: '1400' });
assert.deepEqual(nc, { t: 17.2, wsd: 2.1, pty: 0, rn1: 0, at: '14:00', src: '기상청 실황' });
// MET (UTC 시각 → KST)
const met = parseMet({ properties: { timeseries: [
  { time: '2026-11-10T06:00:00Z', data: { instant: { details: { air_temperature: 8.2, wind_speed: 4, wind_speed_of_gust: 9, cloud_area_fraction: 40 } }, next_1_hours: { details: { precipitation_amount: 0.3 } } } },
  { time: '2026-11-10T12:00:00Z', data: { instant: { details: { air_temperature: 3.1, wind_speed: 2 } }, next_6_hours: { details: { precipitation_amount: 1.2 } } } }] } });
assert.equal(met.hours['2026-11-10T15:00'].gust, 9); assert.equal(met.hours['2026-11-10T15:00'].ph, 1); assert.equal(met.hours['2026-11-10T21:00'].ph, 6);
// 합치기: 기상청 없는 시간은 kma:null
const out = combine({ fcst: fc, met, date: '2026-11-10', days: 1 });
assert.equal(out.hours.length, 2); assert.equal(out.hours.find(h => h.time === '2026-11-10T21:00').kma, null);
assert.equal(out.days.length, 2); assert.deepEqual([out.days[0].kma.tmin, out.days[0].kma.tmax], [-1, 12]); assert.equal(out.days[0].met.tmin, 3.1);
assert.equal(out.kmaRange, '2026-11-10T15:00');
console.log('모두 통과');
