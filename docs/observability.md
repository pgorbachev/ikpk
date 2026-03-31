# Observability Plan — ikpk.su

## Metrics to Track

### Infrastructure

| Metric | Source | Granularity | Retention |
|--------|--------|-------------|-----------|
| CDN response codes (2xx/3xx/4xx/5xx) | CDN analytics (Netlify/Vercel) | Per minute | 30 days |
| TTFB by page template | Lighthouse CI / CDN analytics | Per run / hourly | 90 days |
| CDN bandwidth & request count | CDN dashboard | Hourly | 30 days |
| Uptime (homepage, key pages) | UptimeRobot or similar | 1-min checks | 90 days |

### Application

| Metric | Source | Granularity | Retention |
|--------|--------|-------------|-----------|
| Strapi health endpoint | `GET /api/_health` or `GET /_health` | 1-min checks | 90 days |
| Strapi response time | Monitoring probe | Per check | 30 days |
| Build duration | CI/CD logs (GitHub Actions) | Per build | Unlimited |
| Build success/failure | CI/CD logs | Per build | Unlimited |

### Performance

| Metric | Source | Granularity | Retention |
|--------|--------|-------------|-----------|
| Lighthouse Performance score | Lighthouse CI (GitHub Actions) | Weekly + per-deploy | Unlimited |
| LCP, TBT, CLS, FCP, SI | Lighthouse CI | Weekly + per-deploy | Unlimited |
| Page weight (HTML, JS, CSS, images) | Lighthouse CI | Per deploy | Unlimited |

### SEO

| Metric | Source | Granularity | Retention |
|--------|--------|-------------|-----------|
| Yandex indexation count | `site:ikpk.su` in Yandex | Weekly (manual) | Log in spreadsheet |
| Google indexation count | `site:ikpk.su` in Google | Weekly (manual) | Log in spreadsheet |
| Crawl errors | Yandex.Webmaster / GSC | Daily (check panel) | Per platform retention |
| 404 pages in crawl | CDN logs + `validate-urls.ts` | Weekly | 30 days |
| Lighthouse SEO score | Lighthouse CI | Weekly | Unlimited |

### User Analytics

| Metric | Source | Granularity | Retention |
|--------|--------|-------------|-----------|
| Page views | Yandex.Metrika (counter `39506315`) | Real-time | Per Metrika retention |
| Bounce rate | Yandex.Metrika | Daily | Per Metrika retention |
| Session duration | Yandex.Metrika | Daily | Per Metrika retention |
| Traffic sources | Yandex.Metrika | Daily | Per Metrika retention |
| Form submissions | Strapi + Yandex.Metrika goals | Per event | Per Metrika retention |

---

## Tools

### Yandex.Metrika (counter `39506315`)

**Purpose:** User analytics — traffic, page views, bounce rate, goals.

**Setup:**
- Counter script in `<head>` of all pages (Astro layout component)
- Configure goals for form submissions (subscription, application)
- Set up segments for key page templates (courses, seminars, articles)

### CDN Analytics (Netlify/Vercel built-in)

**Purpose:** Infrastructure metrics — response codes, bandwidth, request volume.

**Setup:**
- Enabled by default on Netlify Analytics / Vercel Analytics
- Review dashboard daily during first 2 weeks post-launch
- Export data weekly for trend tracking

### Lighthouse CI (GitHub Actions)

**Purpose:** Performance regression detection on every deploy + weekly monitoring.

**Setup:** Add workflow `.github/workflows/lighthouse-ci.yml`:

```yaml
name: Lighthouse CI
on:
  # Run on every deploy
  workflow_run:
    workflows: ["Deploy"]
    types: [completed]
  # Weekly schedule
  schedule:
    - cron: "0 6 * * 1"  # Every Monday at 06:00 UTC
  workflow_dispatch: {}

jobs:
  lighthouse:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build site
        run: cd web && npm ci && npm run build

      - name: Run Lighthouse CI
        uses: treosh/lighthouse-ci-action@v12
        with:
          urls: |
            http://localhost:4321/
            http://localhost:4321/institut-klinicheskoy-prikladnoy-kineziologii/kinezioteypirovanie/
            http://localhost:4321/institut-klinicheskoy-prikladnoy-kineziologii/kinezioteypirovanie/kinezioteypirovanie-seminar/
            http://localhost:4321/statyi/
          runs: 5
          configPath: ./lighthouserc.json

      - name: Upload results
        uses: actions/upload-artifact@v4
        with:
          name: lighthouse-results
          path: .lighthouseci/
```

### UptimeRobot (or similar)

**Purpose:** Uptime monitoring with alerting.

**Setup:**
- Monitor 1: `https://ikpk.su/` — HTTP check, 1-min interval
- Monitor 2: `https://ikpk.su/raspisanie` — HTTP check, 5-min interval
- Monitor 3: Strapi health endpoint — HTTP check, 5-min interval
- Alert contacts: email + Telegram (if available)

---

## Alerting Rules

### Critical (immediate response required)

| Condition | Detection | Alert channel | Response |
|-----------|-----------|---------------|----------|
| Homepage unreachable for ≥ 2 minutes | UptimeRobot | Email + Telegram | Check CDN status, DNS, deploy status |
| 5xx rate > 1% for ≥ 5 minutes | CDN analytics alert | Email | Check CDN logs, redeploy if needed |
| Strapi API unreachable for ≥ 5 minutes | UptimeRobot | Email + Telegram | Check VPS/cloud, restart Strapi |

### Warning (investigate within 24 hours)

| Condition | Detection | Alert channel | Response |
|-----------|-----------|---------------|----------|
| 404 rate > 2% for ≥ 1 hour | CDN analytics | Email | Review 404 paths, add missing redirects |
| Lighthouse Performance drop > 10 points | Lighthouse CI | GitHub notification | Review recent deploy, check for regressions |
| Build failure | GitHub Actions | GitHub notification | Fix build, redeploy |

### Informational (review weekly)

| Condition | Detection | Review |
|-----------|-----------|--------|
| Indexation count change > 10% | Manual `site:ikpk.su` check | Weekly SEO review |
| Traffic drop > 30% week-over-week | Yandex.Metrika | Weekly analytics review |
| New crawl errors in Webmaster/GSC | Webmaster panel | Weekly SEO review |

---

## Dashboards

### Daily Operations Dashboard

Check these every morning during the first 2 weeks post-launch:

1. **CDN dashboard** — response codes, request volume, bandwidth
2. **UptimeRobot** — uptime percentage, incidents
3. **Yandex.Metrika** — yesterday's traffic, compare with pre-launch baseline

### Weekly Review Dashboard

1. **Lighthouse CI results** — performance trends for 4 templates
2. **Indexation count** — `site:ikpk.su` in Yandex and Google
3. **Webmaster/GSC** — crawl errors, indexation issues
4. **URL validation** — run `validate-urls.ts` script

### Post-launch Report Template

Generate a brief report at the end of each week (weeks 1–4):

```
## Week N Post-launch Report — ikpk.su

**Period:** YYYY-MM-DD to YYYY-MM-DD

### Uptime
- Uptime: ___%
- Incidents: [list or "none"]

### Performance
- Lighthouse Performance (mobile): home=__, course=__, seminar=__, articles=__
- 5xx rate: ___%
- 404 rate: ___%

### SEO
- Yandex indexed pages: ___
- Google indexed pages: ___
- Crawl errors: [count]

### Traffic
- Daily pageviews (avg): ___
- Bounce rate: ___%
- Compared to pre-launch: +/-___%

### Action Items
- [ ] ...
```
