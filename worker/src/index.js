// 짐로그 날씨 중계 서버
// GET /weather?lat=..&lng=..&date=YYYY-MM-DD&days=N
// 기상청(단기예보·초단기실황)과 MET Norway를 받아 앱이 쓰기 쉬운 JSON 하나로 합쳐 준다.
// 인증키(KMA_KEY)는 Worker 비밀값으로만 쓰고, 코드·응답·로그에 남기지 않는다.
import { toGrid } from './grid.js';
import { kst, ymdDash, hourKey, fcstBase, ncstBase } from './time.js';

const KMA_BASE = 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0';
const MET_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/complete';
const MET_UA = 'jimlog/1.0 https://sinung880222-cloud.github.io/jimlog/';
const ALLOW_ORIGIN = /^(https:\/\/sinung880222-cloud\.github\.io|http:\/\/localhost(:\d+)?|http:\/\/127\.0\.0\.1(:\d+)?)$/;
const FCST_ITEMS = new Set(['TMP', 'TMN', 'TMX', 'POP', 'PTY', 'PCP', 'SKY', 'WSD', 'VEC', 'REH', 'SNO']);

/* ── 공통 ── */
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const round1 = v => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
function corsHeaders(origin) {
  const h = { 'Vary': 'Origin' };
  if (origin && ALLOW_ORIGIN.test(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}
function json(body, status, origin, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(origin), ...extra } });
}
const scrub = (msg, key) => {   // 오류 문장에 키가 섞여 나가지 않게
  let s = String(msg || '오류');
  if (key) { s = s.split(key).join('***'); s = s.split(encodeURIComponent(key)).join('***'); }
  return s.slice(0, 160);
};

/* ── Cache API: 원본 응답 텍스트를 잠깐 저장 (키에는 격자·발표시각만, 인증키는 넣지 않는다) ── */
async function cached(cacheKey, fetcher, ctx) {
  const cache = caches.default;
  const req = new Request('https://cache.jimlog.invalid/' + cacheKey);
  const hit = await cache.match(req);
  if (hit) return hit.text();
  const { text, ttl } = await fetcher();
  if (ttl > 0) {
    const res = new Response(text, { headers: { 'Cache-Control': `public, max-age=${Math.floor(ttl)}` } });
    ctx.waitUntil(cache.put(req, res));
  }
  return text;
}
async function getText(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(9000) });
  const text = await res.text();
  if (!res.ok) { const m = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80); throw new Error(`HTTP ${res.status}${m ? ' ' + m : ''}`); }   // 상대 서버가 알려 준 이유를 같이 보여 준다(키는 scrub이 가린다)
  return { text, res };
}

/* ── 기상청 ── */
function kmaItems(text) {   // 공공데이터포털은 키 오류일 때 JSON 대신 XML을 준다
  if (text.trim().startsWith('<')) {
    const m = text.match(/<returnAuthMsg>([^<]*)</) || text.match(/<errMsg>([^<]*)</) || text.match(/<resultMsg>([^<]*)</);
    throw new Error(m ? m[1] : '기상청 응답을 읽지 못했어요');
  }
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new Error('기상청 응답을 읽지 못했어요'); }
  const hd = j.response && j.response.header;
  if (!hd || hd.resultCode !== '00') throw new Error(hd ? `${hd.resultCode} ${hd.resultMsg}` : '기상청 응답 형식 오류');
  const it = j.response.body && j.response.body.items && j.response.body.items.item;
  return Array.isArray(it) ? it : it ? [it] : [];
}
async function kmaFetch(path, params, key, cacheKey, ttl, ctx) {
  const text = await cached(cacheKey, async () => {
    const q = Object.entries({ serviceKey: key, pageNo: 1, dataType: 'JSON', ...params }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const { text } = await getText(`${KMA_BASE}/${path}?${q}`);
    kmaItems(text);                       // 오류 응답이면 여기서 던져 캐시하지 않는다
    return { text, ttl };
  }, ctx);
  return kmaItems(text);
}
// 단기예보 → { hours: {"2026-11-10T15:00": {t,pop,pty,pcp,sky,wsd,vec,reh,sno}}, tmn:{날짜:값}, tmx:{날짜:값} }
export function parseFcst(items) {
  const hours = {}, tmn = {}, tmx = {};
  for (const it of items) {
    if (!FCST_ITEMS.has(it.category)) continue;
    const d = `${it.fcstDate.slice(0, 4)}-${it.fcstDate.slice(4, 6)}-${it.fcstDate.slice(6, 8)}`;
    if (it.category === 'TMN') { tmn[d] = num(it.fcstValue); continue; }
    if (it.category === 'TMX') { tmx[d] = num(it.fcstValue); continue; }
    const k = `${d}T${it.fcstTime.slice(0, 2)}:00`;
    const o = hours[k] || (hours[k] = { t: null, pop: null, pty: 0, pcp: null, sky: null, wsd: null, vec: null, reh: null, sno: null });
    switch (it.category) {
      case 'TMP': o.t = num(it.fcstValue); break;
      case 'POP': o.pop = num(it.fcstValue); break;
      case 'PTY': o.pty = num(it.fcstValue) || 0; break;
      case 'PCP': o.pcp = it.fcstValue; break;          // "강수없음" · "1.0mm" · "30.0~50.0mm" 같은 글자
      case 'SKY': o.sky = num(it.fcstValue); break;
      case 'WSD': o.wsd = num(it.fcstValue); break;
      case 'VEC': o.vec = num(it.fcstValue); break;
      case 'REH': o.reh = num(it.fcstValue); break;
      case 'SNO': o.sno = it.fcstValue; break;
    }
  }
  return { hours, tmn, tmx };
}
export function parseNcst(items, base) {
  const v = {};
  for (const it of items) v[it.category] = num(it.obsrValue);
  if (v.T1H === undefined && v.WSD === undefined) return null;
  return { t: v.T1H ?? null, wsd: v.WSD ?? null, pty: v.PTY || 0, rn1: v.RN1 ?? null, at: `${base.time.slice(0, 2)}:${base.time.slice(2)}`, src: '기상청 실황' };
}

/* ── MET Norway ── */
async function metFetch(lat, lng, ctx) {
  const key = `met/${lat.toFixed(2)},${lng.toFixed(2)}`;   // 약 1km 단위로 뭉쳐서 저장·요청 (좌표를 그대로 남기지 않는다)
  return JSON.parse(await cached(key, async () => {
    const { text, res } = await getText(`${MET_URL}?lat=${lat.toFixed(2)}&lon=${lng.toFixed(2)}`, { headers: { 'User-Agent': MET_UA, 'Accept': 'application/json' } });
    const exp = Date.parse(res.headers.get('Expires') || '');           // MET가 정한 만료 시각을 지킨다
    const ttl = Number.isFinite(exp) ? Math.max(60, Math.min(3600, (exp - Date.now()) / 1000)) : 600;
    return { text, ttl };
  }, ctx));
}
// → { hours: {"…T15:00": {t,wsd,gust,precip,ph,cloud}} }
export function parseMet(j) {
  const hours = {};
  for (const e of (j.properties && j.properties.timeseries) || []) {
    const k = hourKey(kst(Date.parse(e.time)));
    const d = (e.data && e.data.instant && e.data.instant.details) || {};
    const n1 = e.data && e.data.next_1_hours && e.data.next_1_hours.details;
    const n6 = e.data && e.data.next_6_hours && e.data.next_6_hours.details;
    hours[k] = {
      t: d.air_temperature ?? null, wsd: d.wind_speed ?? null, gust: d.wind_speed_of_gust ?? null,
      precip: n1 ? (n1.precipitation_amount ?? null) : n6 ? (n6.precipitation_amount ?? null) : null,
      ph: n1 ? 1 : n6 ? 6 : null,                       // precip가 몇 시간 치 합인지
      cloud: d.cloud_area_fraction ?? null,
    };
  }
  return { hours };
}

/* ── 합치기 ── */
export function combine({ fcst, met, date, days }) {
  const start = new Date(`${date}T00:00:00Z`).getTime(), end = start + (days + 1) * 86400000;   // 출발일 0시 ~ 마지막 날 24시 (KST 벽시계)
  const inRange = k => { const ms = Date.parse(k + ':00Z'); return ms >= start && ms < end; };
  const keys = new Set([...Object.keys(fcst ? fcst.hours : {}), ...Object.keys(met ? met.hours : {})]);
  const hours = [...keys].filter(inRange).sort().map(k => {
    const a = fcst && fcst.hours[k], b = met && met.hours[k];
    return { time: k, kma: a || null, met: b ? { t: b.t, wsd: b.wsd, gust: b.gust, precip: b.precip, ph: b.ph, cloud: b.cloud } : null };
  });
  const daysOut = [];
  for (let i = 0; i <= days; i++) {
    const d = new Date(start + i * 86400000).toISOString().slice(0, 10);
    const hs = hours.filter(h => h.time.startsWith(d));
    const stat = arr => { const v = arr.filter(x => x !== null && x !== undefined); return v.length ? v : null; };
    let kma = null;
    if (fcst) {
      const ts = stat(hs.map(h => h.kma && h.kma.t)), ws = stat(hs.map(h => h.kma && h.kma.wsd));
      const tmin = fcst.tmn[d] ?? (ts ? Math.min(...ts) : null), tmax = fcst.tmx[d] ?? (ts ? Math.max(...ts) : null);
      if (tmin !== null || tmax !== null) kma = { tmin, tmax, wsdMax: ws ? Math.max(...ws) : null };
    }
    let m = null;
    if (met) {
      const ts = stat(hs.map(h => h.met && h.met.t)), ws = stat(hs.map(h => h.met && h.met.wsd)), gs = stat(hs.map(h => h.met && h.met.gust));
      if (ts) m = { tmin: round1(Math.min(...ts)), tmax: round1(Math.max(...ts)), wsdMax: ws ? Math.max(...ws) : null, gustMax: gs ? Math.max(...gs) : null };
    }
    daysOut.push({ date: d, kma, met: m });
  }
  const kmaKeys = Object.keys(fcst ? fcst.hours : {}).sort();
  return { hours, days: daysOut, kmaRange: kmaKeys.length ? kmaKeys[kmaKeys.length - 1] : null };
}

/* ── 요청 처리 ── */
async function handleWeather(url, env, ctx, origin) {
  const lat = num(url.searchParams.get('lat')), lng = num(url.searchParams.get('lng'));
  const date = url.searchParams.get('date') || '';
  let days = parseInt(url.searchParams.get('days') || '0', 10);
  if (lat === null || lng === null || lat < 20 || lat > 45 || lng < 115 || lng > 135) return json({ error: 'lat, lng(한국 부근 좌표)가 필요해요' }, 400, origin);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return json({ error: 'date는 YYYY-MM-DD 형식이에요' }, 400, origin);
  if (!Number.isFinite(days) || days < 0) days = 0;
  days = Math.min(days, 7);
  const today = ymdDash(kst());
  const ahead = (Date.parse(date) - Date.parse(today)) / 86400000;
  if (ahead > 10) return json({ error: '출발 10일 전부터 예보를 볼 수 있어요' }, 400, origin);

  const grid = toGrid(lat, lng), errors = [], key = String(env.KMA_KEY || '').trim().replace(/^["']|["']$/g, '');   // 붙여넣을 때 섞인 공백·줄바꿈·따옴표 제거
  const fb = fcstBase(), nb = ncstBase();
  const gridOk = grid.nx >= 1 && grid.nx <= 149 && grid.ny >= 1 && grid.ny <= 253;

  const jobs = await Promise.allSettled([
    (async () => {
      if (!key) throw new Error('KMA_KEY가 설정되지 않았어요');
      if (!gridOk) throw new Error('기상청 예보 구역 밖이에요');
      const items = await kmaFetch('getVilageFcst', { numOfRows: 1500, base_date: fb.date, base_time: fb.time, nx: grid.nx, ny: grid.ny }, key, `kma-fcst/${grid.nx},${grid.ny}/${fb.date}${fb.time}`, 3600, ctx);
      return parseFcst(items);
    })(),
    (async () => {
      if (!key || !gridOk) return null;
      const items = await kmaFetch('getUltraSrtNcst', { numOfRows: 20, base_date: nb.date, base_time: nb.time, nx: grid.nx, ny: grid.ny }, key, `kma-ncst/${grid.nx},${grid.ny}/${nb.date}${nb.time}`, 1800, ctx);
      return parseNcst(items, nb);
    })(),
    (async () => parseMet(await metFetch(lat, lng, ctx)))(),
  ]);
  const [fc, nc, mt] = jobs;
  const fail = (src, r) => errors.push({ src, msg: scrub(r.reason && r.reason.message, key) });
  if (fc.status === 'rejected') fail('kma', fc);
  if (nc.status === 'rejected') fail('kma-now', nc);
  if (mt.status === 'rejected') fail('met', mt);
  const fcst = fc.status === 'fulfilled' ? fc.value : null, met = mt.status === 'fulfilled' ? mt.value : null;
  const now = nc.status === 'fulfilled' ? nc.value : null;

  const out = combine({ fcst, met, date, days });
  const body = {
    updatedAt: new Date().toISOString(), grid, now, hours: out.hours, days: out.days, kmaRange: out.kmaRange,
    sources: [fcst && '기상청 단기예보', now && '기상청 초단기실황', met && 'MET Norway'].filter(Boolean),
    errors,
  };
  return json(body, 200, origin, { 'Cache-Control': 'public, max-age=300' });
}


/* ── /daily: 오늘부터 10일 뒤까지 날짜별 아이콘·기온 (달력용) ── */
const KMA_ICON = { 1: 'rain', 2: 'rain', 3: 'snow', 4: 'shower' };
const skyIcon = v => (v === 1 ? 'sun' : v === 3 ? 'partly' : v === 4 ? 'cloud' : null);
const cloudIcon = c => (c === null || c === undefined ? null : c < 25 ? 'sun' : c < 70 ? 'partly' : 'cloud');
export function parseMetDaily(j) {   // KST 날짜별: 최저·최고, 낮(9~18시) 구름·강수, 강수확률
  const days = {};
  for (const e of (j.properties && j.properties.timeseries) || []) {
    const k = kst(Date.parse(e.time)), d = ymdDash(k), hr = k.getUTCHours();
    const o = days[d] || (days[d] = { temps: [], dayCloud: [], dayRate: [], pop: [], wsd: [], gust: [] });
    const det = (e.data && e.data.instant && e.data.instant.details) || {};
    if (det.air_temperature !== undefined) o.temps.push(det.air_temperature);
    if (det.wind_speed !== undefined) o.wsd.push(det.wind_speed);
    if (det.wind_speed_of_gust !== undefined) o.gust.push(det.wind_speed_of_gust);
    const n1 = e.data && e.data.next_1_hours && e.data.next_1_hours.details, n6 = e.data && e.data.next_6_hours && e.data.next_6_hours.details;
    const rate = n1 && n1.precipitation_amount !== undefined ? n1.precipitation_amount : n6 && n6.precipitation_amount !== undefined ? n6.precipitation_amount / 6 : null;
    const pp = n1 && n1.probability_of_precipitation !== undefined ? n1.probability_of_precipitation : n6 && n6.probability_of_precipitation !== undefined ? n6.probability_of_precipitation : null;
    if (pp !== null) o.pop.push(pp);
    if (hr >= 9 && hr <= 18) { if (det.cloud_area_fraction !== undefined) o.dayCloud.push(det.cloud_area_fraction); if (rate !== null) o.dayRate.push(rate); }
  }
  const out = {};
  for (const d of Object.keys(days)) {
    const o = days[d];
    if (!o.temps.length) continue;
    const t = o.temps, mean = t.reduce((a, b) => a + b, 0) / t.length, rate = o.dayRate.length ? Math.max(...o.dayRate) : 0;
    const cloud = o.dayCloud.length ? o.dayCloud.reduce((a, b) => a + b, 0) / o.dayCloud.length : null;
    out[d] = { tmin: round1(Math.min(...t)), tmax: round1(Math.max(...t)), pop: o.pop.length ? Math.max(...o.pop) : null, wsdMax: o.wsd.length ? round1(Math.max(...o.wsd)) : null, gustMax: o.gust.length ? round1(Math.max(...o.gust)) : null, icon: rate >= 0.1 ? (mean <= 1 ? 'snow' : 'rain') : cloudIcon(cloud) };
  }
  return out;
}
export function buildDaily({ fcst, metDays, today, count = 11 }) {   // 기상청 단기예보가 닿는 날은 기상청, 그 뒤는 MET
  const out = [], base = new Date(today + 'T00:00:00Z').getTime();
  for (let i = 0; i < count; i++) {
    const date = new Date(base + i * 86400000).toISOString().slice(0, 10);
    const hs = fcst ? Object.keys(fcst.hours).filter(k => k.startsWith(date)).sort().map(k => [Number(k.slice(11, 13)), fcst.hours[k]]) : [];
    if (hs.length && hs.some(([, h]) => h.sky !== null || h.pty)) {
      const noon = hs.filter(([hr]) => hr >= 12 && hr <= 15), pool = noon.length ? noon : hs.filter(([hr]) => hr >= 9 && hr <= 18).length ? hs.filter(([hr]) => hr >= 9 && hr <= 18) : hs;
      const rainy = pool.find(([, h]) => h.pty > 0), skyH = pool.find(([, h]) => h.sky !== null);
      const ts = hs.map(([, h]) => h.t).filter(v => v !== null), pops = hs.map(([, h]) => h.pop).filter(v => v !== null);
      out.push({ date, icon: rainy ? (KMA_ICON[rainy[1].pty] || 'rain') : skyH ? skyIcon(skyH[1].sky) : null,
        tmin: fcst.tmn[date] ?? (ts.length ? Math.min(...ts) : null), tmax: fcst.tmx[date] ?? (ts.length ? Math.max(...ts) : null), pop: pops.length ? Math.max(...pops) : null,
        wsdMax: (() => { const w = hs.map(([, h]) => h.wsd).filter(v => v !== null); return w.length ? Math.max(...w) : null; })(), gustMax: null, src: 'kma' });
    } else if (metDays && metDays[date]) out.push({ date, ...metDays[date], src: 'met' });
    else out.push({ date, icon: null, tmin: null, tmax: null, pop: null, wsdMax: null, gustMax: null, src: null });
  }
  return out;
}
async function handleDaily(url, env, ctx, origin) {
  const lat = num(url.searchParams.get('lat')), lng = num(url.searchParams.get('lng'));
  if (lat === null || lng === null || lat < 20 || lat > 45 || lng < 115 || lng > 135) return json({ error: 'lat, lng(한국 부근 좌표)가 필요해요' }, 400, origin);
  const grid = toGrid(lat, lng), errors = [], key = String(env.KMA_KEY || '').trim().replace(/^["']|["']$/g, '');
  const fb = fcstBase(), gridOk = grid.nx >= 1 && grid.nx <= 149 && grid.ny >= 1 && grid.ny <= 253;
  const [fc, mt] = await Promise.allSettled([
    (async () => {
      if (!key) throw new Error('KMA_KEY가 설정되지 않았어요');
      if (!gridOk) throw new Error('기상청 예보 구역 밖이에요');
      return parseFcst(await kmaFetch('getVilageFcst', { numOfRows: 1500, base_date: fb.date, base_time: fb.time, nx: grid.nx, ny: grid.ny }, key, `kma-fcst/${grid.nx},${grid.ny}/${fb.date}${fb.time}`, 3600, ctx));
    })(),
    (async () => parseMetDaily(await metFetch(lat, lng, ctx)))(),
  ]);
  if (fc.status === 'rejected') errors.push({ src: 'kma', msg: scrub(fc.reason && fc.reason.message, key) });
  if (mt.status === 'rejected') errors.push({ src: 'met', msg: scrub(mt.reason && mt.reason.message, key) });
  const days = buildDaily({ fcst: fc.status === 'fulfilled' ? fc.value : null, metDays: mt.status === 'fulfilled' ? mt.value : null, today: ymdDash(kst()) });
  return json({ updatedAt: new Date().toISOString(), grid, days, errors }, 200, origin, { 'Cache-Control': 'public, max-age=600' });
}

/* ── 장소 검색: NAVER API HUB 지역 검색 (키는 Worker 비밀값 NAVER_SEARCH_ID / NAVER_SEARCH_SECRET) ── */
const SEARCH_URL = 'https://naverapihub.apigw.ntruss.com/search/v1/local';
const stripTags = v => String(v || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
function coordOf(v) {   // mapx/mapy: 문자열. 1e7 배 정수이거나 이미 도(度) 단위일 수 있다
  const n = parseFloat(v); if (!Number.isFinite(n)) return null;
  return Math.abs(n) > 1000 ? n / 1e7 : n;
}
export function parseSearch(j) {
  const items = j && Array.isArray(j.items) ? j.items : [];
  return items.map(x => {
    const lng = coordOf(x.mapx), lat = coordOf(x.mapy);
    if (lat === null || lng === null) return null;
    return { name: stripTags(x.title), addr: stripTags(x.address), roadAddr: stripTags(x.roadAddress), category: stripTags(x.category),
             lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
  }).filter(Boolean);
}
async function handleSearch(url, env, ctx, origin) {
  const q = (url.searchParams.get('q') || '').trim().slice(0, 40);
  if (q.length < 1) return json({ error: 'q(검색어)가 필요해요' }, 400, origin);
  const id = String(env.NAVER_SEARCH_ID || '').trim().replace(/^["']|["']$/g, ''), sec = String(env.NAVER_SEARCH_SECRET || '').trim().replace(/^["']|["']$/g, '');
  if (!id || !sec) return json({ error: '장소 검색 키가 설정되지 않았어요' }, 503, origin);
  try {
    const text = await cached('search/' + encodeURIComponent(q.toLowerCase()), async () => {
      const r = await getText(`${SEARCH_URL}?query=${encodeURIComponent(q)}&display=5`, { headers: { 'X-NCP-APIGW-API-KEY-ID': id, 'X-NCP-APIGW-API-KEY': sec } });
      return { text: r.text, ttl: 600 };   // 같은 검색어 10분
    }, ctx);
    return json({ results: parseSearch(JSON.parse(text)) }, 200, origin, { 'Cache-Control': 'public, max-age=600' });
  } catch (e) {
    return json({ error: scrub(scrub(e && e.message, id), sec) }, 502, origin);
  }
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method !== 'GET') return json({ error: 'GET만 쓸 수 있어요' }, 405, origin);
    const url = new URL(request.url);
    if (url.pathname === '/weather') {
      try { return await handleWeather(url, env, ctx, origin); }
      catch (e) { return json({ error: scrub(e && e.message, env.KMA_KEY) }, 500, origin); }
    }
    if (url.pathname === '/daily') {
      try { return await handleDaily(url, env, ctx, origin); }
      catch (e) { return json({ error: scrub(e && e.message, env.KMA_KEY) }, 500, origin); }
    }
    if (url.pathname === '/search') {
      try { return await handleSearch(url, env, ctx, origin); }
      catch (e) { return json({ error: scrub(e && e.message, env.NAVER_SEARCH_SECRET) }, 500, origin); }
    }
    if (url.pathname === '/') return json({ app: 'jimlog-weather', ok: true }, 200, origin);
    return json({ error: 'not found' }, 404, origin);
  },
};
