# Migration Runbook — ikpk.su Rebuild

## Pre-launch Checklist

Complete **all** items before scheduling go-live.

- [ ] Strapi populated with all content (run `cd scripts && npm run import`, verify entity counts match `discovery/content_dump.json`)
- [ ] All 255 pages building without errors (`cd web && npm run build` — zero errors)
- [ ] Lighthouse CI on 4 templates (home, course, seminar, articles) — record baselines, verify KPI targets (see `docs/kpi-validation.md`)
- [ ] Crawl all URLs from sitemap, verify 200 status (`cd scripts && npx tsx validate-urls.ts --base-url https://staging.ikpk.su`)
- [ ] Test 301 redirects from `discovery/url_map.csv` (script validates all entries; manually spot-check 20+ URLs in browser)
- [ ] UAT sign-off from stakeholder (written confirmation per Этап 5.2)
- [ ] DNS TTL lowered to 300s (at least 24 hours before cutover)
- [ ] Old site accessible via backup IP for rollback (document IP in this section before go-live: `___.___.___.___ `)
- [ ] Yandex.Metrika counter `39506315` added to new site `<head>` and firing on page load
- [ ] Yandex.Webmaster verified for new site (if access available)
- [ ] Google Search Console verified (if access available)
- [ ] Security headers configured on CDN (HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy)
- [ ] Functional parity checklist 100% complete (see `discovery/functional_parity_checklist.md`)

---

## Go-live Steps

Execute in order. Each step has a verification gate — do not proceed until verification passes.

### 1. Final Strapi Data Sync

```bash
cd scripts && npm run import
```

**Verify:** Compare entity counts in Strapi admin panel with expected counts from `discovery/content_dump.json`.

### 2. Build and Deploy to CDN

```bash
cd web && npm run build
```

Deploy the `web/dist/` directory to CDN (Vercel/Netlify).

**Verify:** Build completes with zero errors. Check `dist/` contains expected number of HTML files.

```bash
find web/dist -name '*.html' | wc -l
# Expected: ~255
```

### 3. Verify New Site at CDN URL

Test the staging/preview URL before DNS switch:

```bash
# Validate all sitemap URLs return 200
cd scripts && npx tsx validate-urls.ts --base-url https://preview.ikpk.su

# Quick smoke test
curl -sI https://preview.ikpk.su/ | head -5
curl -sI https://preview.ikpk.su/raspisanie | head -5
curl -sI https://preview.ikpk.su/statyi | head -5
```

**Verify:** All URLs return expected status codes. Visually check home, course, seminar, articles pages.

### 4. Switch DNS to CDN

Update DNS A/CNAME records for `ikpk.su` to point to CDN.

```
# Example (actual values depend on CDN provider)
ikpk.su.  300  IN  CNAME  ikpk-su.netlify.app.
# OR
ikpk.su.  300  IN  A  <CDN-IP>
```

**Verify:** DNS propagation (TTL=300 → full propagation within 5 minutes):

```bash
dig ikpk.su +short
# Should show CDN IP/CNAME

curl -sI https://ikpk.su/ | head -5
# Should return 200 from new site
```

### 5. Submit Sitemap

- **Yandex.Webmaster:** Add property → submit `https://ikpk.su/sitemap-index.xml`
- **Google Search Console:** Add property → submit `https://ikpk.su/sitemap-index.xml`
- **robots.txt** should already contain: `Sitemap: https://ikpk.su/sitemap-index.xml`

### 6. Verify Analytics

- Open `https://ikpk.su` in browser
- Check Yandex.Metrika real-time dashboard for counter `39506315` — confirm pageview appears within 1 minute
- Check browser DevTools → Network tab for `mc.yandex.ru` requests

---

## Post-launch Monitoring (First 2 Weeks)

### Daily

| Check | How | Alert threshold |
|-------|-----|-----------------|
| 404 rate | CDN analytics dashboard (Netlify/Vercel) | > 5% of requests |
| 5xx rate | CDN analytics dashboard | > 1% of requests |
| Index count | Search `site:ikpk.su` in Yandex and Google, record count | Drop > 20% from baseline |
| Yandex.Metrika | Check traffic is tracking, compare with old site baseline | Drop > 50% in daily pageviews |
| Uptime | UptimeRobot / monitoring tool | Any downtime > 2 min |

### Weekly

| Check | How |
|-------|-----|
| Lighthouse Performance on 4 templates | Run Lighthouse CI (see `docs/kpi-validation.md`) |
| Yandex.Webmaster crawl errors | Check Webmaster panel |
| Google Search Console coverage | Check GSC panel |
| 301 redirect validation | Re-run `cd scripts && npx tsx validate-urls.ts --base-url https://ikpk.su` |

### After 2 Weeks

- If no rollback triggered: decommission old site infrastructure
- Archive old site backup for 90 days
- Remove backup IP documentation
- Update this runbook with final status

---

## Rollback Procedure

### Trigger Conditions

Initiate rollback if **any** of the following occur within 14 days of go-live:

- **404 rate > 5%** of all requests (sustained over 1 hour)
- **Indexation drop > 20%** of pages within 7 days (compare `site:ikpk.su` count)
- **Critical functional breakage** reported by stakeholder (forms, payments)
- **Stakeholder requests rollback**

### Rollback Steps

1. **Switch DNS back** to old site IP:
   ```
   ikpk.su.  300  IN  A  <OLD-SITE-IP>
   ```
   With TTL=300, propagation completes within ~5 minutes.

2. **Notify stakeholder** — send rollback notification with:
   - Time of rollback
   - Reason (which trigger condition)
   - Expected resolution timeline

3. **Verify old site** is serving correctly:
   ```bash
   curl -sI https://ikpk.su/ | head -5
   ```

4. **Investigate root cause** — check CDN logs, build output, Strapi health.

5. **Fix and re-attempt** go-live after root cause is resolved.

### Important Constraints During Parallel Period

- Old site runs **read-only** during the 2-week parallel period (forms disabled or redirected)
- **All write operations** (forms, subscriptions, applications) go to the new backend only — single write path regardless of DNS state
- This ensures no data is lost or split between old and new systems
- If write consistency is a concern during cutover, both old and new sites should proxy form submissions to the same API endpoint

### Timeline

```
Day -1:  Lower DNS TTL to 300s
Day  0:  Go-live (DNS switch to CDN)
Day 1-14: Parallel period — old site on standby, daily monitoring
Day 14:  If stable → decommission old site
         If rollback occurred → fix and re-schedule go-live
Day 90:  Remove old site archive
```
