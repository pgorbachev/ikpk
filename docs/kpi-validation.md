# KPI Validation Plan — ikpk.su Rebuild

## KPI Targets

From the rebuild plan, measured on 4 templates: home, course (depth=2), seminar (depth=3), articles.

| KPI | Current | Target | How to Measure | When |
|-----|---------|--------|---------------|------|
| Lighthouse Performance (mobile) | 36–56 | **≥ 85** | Lighthouse CI in Docker, median of 5 runs, mobile preset | Pre-launch + weekly |
| Lighthouse Performance (desktop) | 50–78 | **≥ 90** | Lighthouse CI in Docker, median of 5 runs, desktop preset | Pre-launch + weekly |
| Lighthouse SEO | 92 | **≥ 95** | Lighthouse CI | Pre-launch |
| LCP mobile | 8.6–9.8s | **≤ 2.5s** | Lighthouse CI, mobile preset | Pre-launch + weekly |
| TBT mobile | 290–2070ms | **≤ 200ms** | Lighthouse CI, mobile preset | Pre-launch |
| CLS | 0–0.045 | **≤ 0.1** | Lighthouse CI | Pre-launch |
| TTFB p75 | 360–1130ms | **≤ 300ms** | Synthetic monitoring from Moscow + SPb | Post-launch daily for 2 weeks |
| All sitemap URLs → 200 | ✅ | **100%** | `validate-urls.ts` crawl script | Pre-launch + post-launch |
| 301 redirect coverage | N/A | **100%** of url_map | `validate-urls.ts` redirect checker | Pre-launch + post-launch |
| Functional parity | N/A | **100%** checklist | Manual UAT per `discovery/functional_parity_checklist.md` | Pre-launch |

---

## Measurement Procedures

### 1. Lighthouse Performance (Mobile) — Target ≥ 85

**Method:** Lighthouse CI in Docker for consistent environment, median of 5 runs.

```bash
# Install Lighthouse CI
npm install -g @lhci/cli

# Run against local build (pre-launch)
cd web && npm run build && npx astro preview &
sleep 3

# Mobile preset (default) — 5 runs per URL, median
lhci collect \
  --url=http://localhost:4321/ \
  --url=http://localhost:4321/institut-klinicheskoy-prikladnoy-kineziologii/kinezioteypirovanie/ \
  --url=http://localhost:4321/institut-klinicheskoy-prikladnoy-kineziologii/kinezioteypirovanie/kinezioteypirovanie-seminar/ \
  --url=http://localhost:4321/statyi/ \
  --numberOfRuns=5

# View results
lhci assert --preset=lighthouse:recommended
```

**With Docker (reproducible CI environment):**

```bash
docker run --rm \
  -v $(pwd)/web/dist:/usr/share/nginx/html:ro \
  --name lhci-server \
  -d -p 8080:80 nginx:alpine

lhci collect \
  --url=http://localhost:8080/ \
  --url=http://localhost:8080/institut-klinicheskoy-prikladnoy-kineziologii/kinezioteypirovanie/ \
  --url=http://localhost:8080/institut-klinicheskoy-prikladnoy-kineziologii/kinezioteypirovanie/kinezioteypirovanie-seminar/ \
  --url=http://localhost:8080/statyi/ \
  --numberOfRuns=5

docker stop lhci-server
```

**Pass criteria:** All 4 templates score ≥ 85 (median of 5 runs).

### 2. Lighthouse Performance (Desktop) — Target ≥ 90

```bash
# Same as mobile, but with desktop config
lhci collect \
  --url=http://localhost:4321/ \
  --url=http://localhost:4321/institut-klinicheskoy-prikladnoy-kineziologii/kinezioteypirovanie/ \
  --url=http://localhost:4321/institut-klinicheskoy-prikladnoy-kineziologii/kinezioteypirovanie/kinezioteypirovanie-seminar/ \
  --url=http://localhost:4321/statyi/ \
  --numberOfRuns=5 \
  --settings.preset=desktop
```

**Pass criteria:** All 4 templates score ≥ 90 (median of 5 runs).

### 3. Lighthouse SEO — Target ≥ 95

```bash
# Included in the Lighthouse runs above. Check SEO category in report.
# Key factors: meta tags, canonical, structured data, mobile-friendly
lhci collect \
  --url=http://localhost:4321/ \
  --url=http://localhost:4321/institut-klinicheskoy-prikladnoy-kineziologii/kinezioteypirovanie/ \
  --url=http://localhost:4321/institut-klinicheskoy-prikladnoy-kineziologii/kinezioteypirovanie/kinezioteypirovanie-seminar/ \
  --url=http://localhost:4321/statyi/ \
  --numberOfRuns=1
```

Extract SEO score from the JSON output:

```bash
# Parse Lighthouse JSON report
cat .lighthouseci/lhr-*.json | \
  python3 -c "
import sys, json
for line in sys.stdin:
    data = json.loads(line)
    url = data['finalUrl']
    seo = data['categories']['seo']['score'] * 100
    print(f'{url}: SEO={seo}')
"
```

**Pass criteria:** All 4 templates SEO score ≥ 95.

### 4. LCP Mobile — Target ≤ 2.5s

Extracted from Lighthouse mobile runs (same as #1).

```bash
# Parse from Lighthouse JSON
cat .lighthouseci/lhr-*.json | \
  python3 -c "
import sys, json
for line in sys.stdin:
    data = json.loads(line)
    url = data['finalUrl']
    lcp = data['audits']['largest-contentful-paint']['numericValue'] / 1000
    print(f'{url}: LCP={lcp:.2f}s')
"
```

**Pass criteria:** LCP ≤ 2.5s on all 4 templates (median of 5 runs).

### 5. TBT Mobile — Target ≤ 200ms

Extracted from Lighthouse mobile runs (same as #1).

```bash
cat .lighthouseci/lhr-*.json | \
  python3 -c "
import sys, json
for line in sys.stdin:
    data = json.loads(line)
    url = data['finalUrl']
    tbt = data['audits']['total-blocking-time']['numericValue']
    print(f'{url}: TBT={tbt:.0f}ms')
"
```

**Pass criteria:** TBT ≤ 200ms on all 4 templates.

### 6. CLS — Target ≤ 0.1

Extracted from Lighthouse runs.

```bash
cat .lighthouseci/lhr-*.json | \
  python3 -c "
import sys, json
for line in sys.stdin:
    data = json.loads(line)
    url = data['finalUrl']
    cls = data['audits']['cumulative-layout-shift']['numericValue']
    print(f'{url}: CLS={cls:.3f}')
"
```

**Pass criteria:** CLS ≤ 0.1 on all 4 templates.

### 7. TTFB p75 — Target ≤ 300ms

**Post-launch only** — requires the live CDN. Synthetic monitoring from 2 locations.

**Option A: curl-based measurement script**

```bash
#!/usr/bin/env bash
# Run from Moscow and SPb VPS/cloud instances
URLS=(
  "https://ikpk.su/"
  "https://ikpk.su/institut-klinicheskoy-prikladnoy-kineziologii/kinezioteypirovanie/"
  "https://ikpk.su/institut-klinicheskoy-prikladnoy-kineziologii/kinezioteypirovanie/kinezioteypirovanie-seminar/"
  "https://ikpk.su/statyi/"
)

for url in "${URLS[@]}"; do
  echo "--- $url ---"
  for i in $(seq 1 10); do
    curl -s -o /dev/null -w "%{time_starttransfer}\n" "$url"
    sleep 1
  done | sort -n | awk '{a[NR]=$1} END {print "p75:", a[int(NR*0.75)+1]*1000, "ms"}'
done
```

**Option B: UptimeRobot with response time tracking**

Set up HTTP monitors for the 4 template URLs. UptimeRobot records response times — export weekly and calculate p75.

**Pass criteria:** TTFB p75 ≤ 300ms from both Moscow and SPb measurement points.

### 8. All Sitemap URLs → 200 — Target 100%

```bash
cd scripts && npx tsx validate-urls.ts --base-url http://localhost:4321
```

The script reads `discovery/url_map.csv`, checks all canonical URLs (redirect_type=200) return HTTP 200.

**Pass criteria:** 0 failures for canonical URLs.

### 9. 301 Redirect Coverage — Target 100%

```bash
cd scripts && npx tsx validate-urls.ts --base-url https://ikpk.su
```

The script checks all alias URLs (redirect_type=301) return HTTP 301 with the correct `Location` header.

**Pass criteria:** 0 failures for redirect URLs.

### 10. Functional Parity — Target 100%

Manual UAT walkthrough using `discovery/functional_parity_checklist.md`:

- [ ] Каталог курсов: навигация институт → курс → семинар
- [ ] Расписание и цены: таблица с фильтрацией
- [ ] Форма подписки на новости
- [ ] Страница оплаты (ссылка на платёжный сценарий)
- [ ] Статьи: список + полная статья
- [ ] Видео-каталог: плейлисты
- [ ] Контакты: карта, телефоны, email
- [ ] Акции и скидки
- [ ] Сведения об образовательной организации
- [ ] Навигация: меню, footer, хлебные крошки
- [ ] Мобильная версия
- [ ] Форма обратной связи (если есть)

**Pass criteria:** All items checked off and signed by stakeholder.

---

## Validation Schedule

### Pre-launch (before DNS switch)

| # | KPI | Status |
|---|-----|--------|
| 1 | Lighthouse Performance mobile ≥ 85 | ☐ |
| 2 | Lighthouse Performance desktop ≥ 90 | ☐ |
| 3 | Lighthouse SEO ≥ 95 | ☐ |
| 4 | LCP mobile ≤ 2.5s | ☐ |
| 5 | TBT mobile ≤ 200ms | ☐ |
| 6 | CLS ≤ 0.1 | ☐ |
| 8 | All sitemap URLs → 200 | ☐ |
| 9 | 301 redirect coverage 100% | ☐ |
| 10 | Functional parity 100% | ☐ |

### Post-launch Week 1

| # | KPI | Status |
|---|-----|--------|
| 7 | TTFB p75 ≤ 300ms | ☐ |
| 8 | All sitemap URLs → 200 (re-validate) | ☐ |
| 9 | 301 redirect coverage (re-validate) | ☐ |
| 1 | Lighthouse Performance mobile ≥ 85 | ☐ |
| 2 | Lighthouse Performance desktop ≥ 90 | ☐ |

### Ongoing Weekly (weeks 2–4)

| # | KPI | Status |
|---|-----|--------|
| 1 | Lighthouse Performance mobile ≥ 85 | ☐ |
| 2 | Lighthouse Performance desktop ≥ 90 | ☐ |
| 7 | TTFB p75 ≤ 300ms | ☐ |
