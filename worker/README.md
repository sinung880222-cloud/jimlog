# 짐로그 날씨 서버 (Cloudflare Worker)

앱 → 이 서버 → 기상청(단기예보·초단기실황) + MET Norway. 인증키는 서버 비밀값으로만 둔다(코드·커밋에 쓰지 않음).

```bash
cd worker
npx wrangler login               # 브라우저에서 승인
npx wrangler secret put KMA_KEY  # 공공데이터포털 일반 인증키(Decoding 값)를 프롬프트에 직접 붙여넣기
npx wrangler deploy              # 끝에 나오는 …workers.dev 주소를 index.html의 WEATHER_API에
node test/weather.test.mjs       # 격자 변환·발표시각·응답 정리 검사 (키 불필요)
```

`GET /weather?lat=..&lng=..&date=YYYY-MM-DD&days=N` → `{ updatedAt, grid, now, hours[], days[], kmaRange, sources[], errors[] }`
(MET 좌표는 소수 2자리(약 1km)로 줄여 요청·캐시한다. 허용 출처: GitHub Pages 주소와 localhost.)
