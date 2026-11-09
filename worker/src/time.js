// 한국 표준시(KST) 도우미: Date의 UTC 필드를 KST 벽시계로 쓴다
const pad = n => String(n).padStart(2, '0');
export const kst = (ms = Date.now()) => new Date(ms + 9 * 3600000);              // 이 Date의 getUTC*() = KST 시각
export const ymd = k => `${k.getUTCFullYear()}${pad(k.getUTCMonth() + 1)}${pad(k.getUTCDate())}`;
export const ymdDash = k => `${k.getUTCFullYear()}-${pad(k.getUTCMonth() + 1)}-${pad(k.getUTCDate())}`;
export const hhmm = k => `${pad(k.getUTCHours())}${pad(k.getUTCMinutes())}`;
export const hourKey = k => `${ymdDash(k)}T${pad(k.getUTCHours())}:00`;           // "2026-11-10T15:00" (KST)

const FCST_HOURS = [2, 5, 8, 11, 14, 17, 20, 23];
// 단기예보 발표시각: 발표 10분 뒤부터 쓸 수 있다. 02:10 전이면 어제 23시 발표.
export function fcstBase(nowMs = Date.now()) {
  const t = kst(nowMs - 10 * 60000);
  const h = t.getUTCHours();
  let pick = [...FCST_HOURS].reverse().find(x => x <= h);
  if (pick === undefined) { t.setUTCDate(t.getUTCDate() - 1); pick = 23; }
  return { date: ymd(t), time: `${pad(pick)}00` };
}
// 초단기실황: 매시 40분 이후에 그 시각 자료가 나온다. 40분 전이면 한 시간 전 자료.
export function ncstBase(nowMs = Date.now()) {
  const t = kst(nowMs);
  if (t.getUTCMinutes() < 40) t.setUTCHours(t.getUTCHours() - 1);
  return { date: ymd(t), time: `${pad(t.getUTCHours())}00` };
}
