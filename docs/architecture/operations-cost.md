# Operations Cost for the New Solution

## Load Estimation

### Audience Profile

- Narrow niche: postgraduate medical education (kinesiology, osteopathy)
- Geography: primarily Russia + CIS, main city — Saint Petersburg
- Audience: practicing physicians, massage therapists, osteopaths
- Seasonality: peaks before seminar start dates (announcements in the schedule)

### Traffic Estimation (Conservative)

```
Unique visitors:          100–300 / day
Page views:               300–1000 / day
Peak hours:               10:00–14:00 MSK (weekdays)
Peak load:                1–5 requests / second
Average monthly traffic:  5000–10000 visits
```

**Estimation Rationale:**
- 253 pages, Yandex ICS = low/medium (niche site)
- Yandex badge "Secure connection" (yes), "Popular site" (no)
- No signs of paid traffic (no UTM tags, no /utm/ in URLs)
- 14000+ trained over 20 years → ~700/year → ~60/month active students
- Primary scenario: find a course → schedule → enroll (3–5 pages per visit)

### Infrastructure Load

```
                          Current (VPS)       New (CDN + VPS)
─────────────────────────────────────────────────────────────────
Requests to VPS:          all (~1000/day)     CMS admin panel only
Requests to CDN:          —                   all visitors (~1000/day)
Traffic:                  ~1–5 GB/month       ~1–5 GB/month (CDN)
Peak load on VPS:         1–5 rps             ~0 (visitors don't hit VPS)
Rebuild on update:        —                   ~3 sec build, 2–10 times/week
```

**Actual Content Updates (published via CMS):**
- Schedule: ~1–5 changes/week
- Articles: ~1–2 per month
- News/promos: ~1–2 per month
- Static pages: ~once per quarter
- Total: **~2–10 publishes/week**, each → rebuild ~3 sec

**Conclusion:** load is minimal. Free CDN tiers are more than sufficient.
VPS for Strapi is utilized at ~1–2% — only active when a content manager edits content.

### Precise Data (After Gaining Access to Yandex.Metrica)

The client can provide access to Yandex.Metrica (ID: 39506315).
Once available, verify:

```
Yandex.Metrica → Reports → Traffic:
- Visits/day (30-day average)
- Page views/day
- Pages per visit (view depth)
- Mobile share

Yandex.Metrica → Reports → Site Load:
- Requests/min (peak)
- Average server response time
```

---

## Hosting and Services

### Frontend (Nginx on VPS)

Static files are served by Nginx from the same VPS where Strapi runs.
With 100–300 visitors/day, no additional server is needed.

```
Frontend cost: 0 RUB/month (included in CMS VPS cost)
```

**Scaling (if needed):**
If traffic grows by an order of magnitude, a Russian CDN can be added
(Selectel CDN, Yandex Cloud CDN, G-Core Labs) in front of Nginx with no architecture changes.
For a CIS audience, TTFB from a Moscow VPS is ~30–80 ms (target ≤ 300 ms).

### CMS (Strapi)

Strapi requires a VPS — it runs as a Node.js application + PostgreSQL.

| Provider | Configuration | Price | Notes |
|----------|--------------|-------|-------|
| **Timeweb Cloud** | 2 vCPU, 4 GB RAM, 40 GB SSD | ~900 RUB/month | Russian provider, no sanctions risk |
| **Selectel** | 2 vCPU, 4 GB RAM, 40 GB SSD | ~1200 RUB/month | Russian provider, reliable |

**Recommendation:** Timeweb Cloud or Selectel — Russian providers, payment in RUB,
not subject to blocking. The same VPS also runs Nginx for serving static files.

**Minimum requirements:** 2 vCPU, 2 GB RAM (Nginx + Strapi + PostgreSQL).
4 GB RAM is recommended for comfortable work with media.

```
CMS server cost: 900–1200 RUB/month
```

### Media Storage (Images, PDF)

| Option | Price | Notes |
|--------|-------|-------|
| **Yandex Cloud Storage** (current) | ~100–300 RUB/month | Already in use, no need to change |
| **Strapi Media on VPS** | 0 RUB (included in VPS) | Simpler, but requires separate backups |

**Recommendation:** keep Yandex Cloud Storage — already configured, all URLs are preserved.

```
Media cost: 100–300 RUB/month (already being paid)
```

### Domain

```
ikpk.su — already owned, renewal ~300–500 RUB/year
```

### SSL Certificate

```
Nginx + Certbot on the VPS — free, auto-renewal
```

### Analytics

```
Yandex.Metrica — free
Mail.ru Top — free
```

### Search (Pagefind)

```
Free — index is generated at build time, runs in the browser
```

## Total: Monthly Infrastructure Costs

```
Frontend (Nginx on VPS):       0 RUB (included in VPS)
CMS server (VPS):              900–1200 RUB
Media (Yandex Cloud):          100–300 RUB (already in place)
SSL:                            0 RUB
Analytics:                      0 RUB
Search:                         0 RUB
─────────────────────────────────────
TOTAL:                          1000–1500 RUB/month (~12000–18000 RUB/year)
```

Everything is hosted within Russia. No foreign services are used.

For comparison: the current site also runs on VPS + Yandex Cloud,
so infrastructure costs remain roughly the same.

---

## Ongoing Maintenance (Time)

### Technical Maintenance

| Task | Frequency | Time | Notes |
|------|-----------|------|-------|
| Strapi updates (minor) | Once/month | 1–2 h | npm update + verification |
| Astro updates | Once/month | 0.5–1 h | npm update + build + deploy |
| Dependency updates (security patches) | As needed | 0.5–1 h | Dependabot notifications |
| Database backup | Automatic (daily) | 0 h | One-time setup |
| CMS uptime monitoring | Automatic | 0 h | UptimeRobot (free) |
| 404/error monitoring | Once/month | 0.5 h | Crawl + log review |
| SSL renewal | Automatic | 0 h | Let's Encrypt / CDN |

```
Total technical maintenance: 2–4 hours/month
```

### SEO Maintenance

| Task | Frequency | Time | Notes |
|------|-----------|------|-------|
| Indexing check (Yandex + Google) | Once/month | 0.5 h | site:ikpk.su, Search Console |
| Lighthouse audit (4 templates) | Once/month | 0.5 h | Automated via CI |
| Broken link check | Once/month | 0.5 h | Automated crawl |
| Schema markup updates | As needed | 1–2 h | When adding new content types |
| Search query analysis | Once/month | 1 h | Yandex.Metrica + Webmaster |
| Meta tag optimization | As needed | 1–2 h | Based on analytics data |

```
Total SEO: 3–6 hours/month (first 3 months after launch — more)
```

### Content Maintenance (If Handled by Developer, Not Content Manager)

| Task | Frequency | Time | Notes |
|------|-----------|------|-------|
| Schedule updates | On request | 0.5 h | Via CMS (content manager can do this) |
| Article publishing | On request | 0.5 h | Via CMS (content manager can do this) |
| Adding a seminar | On request | 0.5–1 h | Via CMS (content manager can do this) |

**With a CMS in place**, the content manager handles this independently.
A developer is only needed for structural changes (new page type, new component).

## Total: Monthly Cost of Ownership

```
Infrastructure:           1000–1500 RUB/month
Technical maintenance:    2–4 h/month
SEO:                      3–6 h/month
─────────────────────────────────────
Recurring costs:          1000–1500 RUB + 5–10 hours/month

First 3 months after launch: +3–5 h/month (post-migration monitoring)
```
