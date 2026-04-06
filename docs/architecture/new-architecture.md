# New Solution Architecture

## Overview

The new website is built on **Astro (static site generator) + Strapi CMS**.
Frontend and backend are fully decoupled. Each component can be replaced independently.

**Constraint:** all production and runtime services are hosted within the Russian Federation.
Foreign CDN/hosting platforms (Cloudflare, Netlify, Vercel, etc.) are not used.
CI/CD builds run via GitHub Actions but deploy exclusively to RF-hosted infrastructure
(alternatively, a self-hosted runner on the VPS can be used to keep the entire pipeline in RF).

## Technology Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Frontend | Astro (SSG) | Static HTML pages |
| CMS | Strapi | Admin panel with web UI + REST API |
| Search | Pagefind | Full-text in-browser search, no server required |
| Interactivity | React (islands) | Only for forms and filters (~20–50 KB JS) |
| Hosting | Russian VPS | Nginx (static files) + Strapi + PostgreSQL |
| Media storage | Yandex Cloud Storage | No changes, fully compatible |

**JavaScript budget:** basic pages — 0 KB JS. Pages with interactivity
(search, forms, schedule filter) load ~20–50 KB React islands on demand.
For comparison: the current site ships ~500 KB JS on every page.

## Architecture

```
┌─ Russian VPS (Timeweb / Selectel) ──────────────────┐
│                                                      │
│  ┌─────────────────────────────────────────────────┐ │
│  │               Nginx                             │ │
│  │                                                 │ │
│  │  Static files (port 80/443):                    │ │
│  │  • ~253 HTML pages (Astro SSG)                  │ │
│  │  • CSS + fonts + SVG                            │ │
│  │  • React islands (~20–50 KB, on demand):        │ │
│  │    – Site search (Pagefind)                     │ │
│  │    – Schedule filter                            │ │
│  │    – Seminar enrollment form                    │ │
│  │    – Newsletter subscription form               │ │
│  │                                                 │ │
│  │  Reverse proxy → Strapi (port 1337):            │ │
│  │  • /admin/* → CMS admin panel                   │ │
│  │  • /api/*   → REST API (forms, webhook)         │ │
│  └─────────────────────────────────────────────────┘ │
│                                                      │
│  ┌───────────────────┐  ┌────────────────────────┐   │
│  │   Strapi CMS      │  │  PostgreSQL            │   │
│  │   (Node.js)       │──│  (database)            │   │
│  │                   │  └────────────────────────┘   │
│  │   Admin panel:    │                               │
│  │   https://<CMS_HOST>/admin                        │
│  │                   │                               │
│  │   • WYSIWYG       │                               │
│  │   • Media upload  │                               │
│  │   • Roles: admin / editor                         │
│  │                   │                               │
│  │   REST API:       │                               │
│  │   • /api/institutes                               │
│  │   • /api/seminars                                 │
│  │   • /api/articles                                 │
│  │   • /api/teachers                                 │
│  │   • /api/schedule-entries                         │
│  │   • /api/form-submissions (seminar applications)  │
│  │   • /api/payments (YooKassa integration)          │
│  └───────────────────┘                               │
│                                                      │
│  Yandex Cloud Storage (media) — external service     │
└──────────────────────────────────────────────────────┘

The URL of the specific CMS host (subdomain or separate domain)
is set at deploy time; <CMS_HOST> is used throughout this document.
```

## Fault Tolerance

The static site and the CMS have separate areas of responsibility:

```
Strapi CMS is down (VPS reboot, update):
  Visitors     → site works (Nginx serves static files)
  Search       → works (Pagefind runs in the browser)
  Forms        → DO NOT work (depend on Strapi API)
  Manager      → CANNOT edit content

Nginx is down:
  Entire site  → DOES NOT work
  Mitigation   → systemd auto-restart, UptimeRobot monitoring
```

Key advantage: **visitors can browse the site even when the CMS is unavailable**.
The current monolith (Next.js + Express) takes the entire site down on any failure.

## Forms: Submission Architecture

Forms (seminar enrollment, newsletter subscription) send data
to the **Strapi REST API** (`POST /api/form-submissions`).

```
Visitor fills out the form
       │
       ▼
React island (client-side validation)
       │
       ▼ POST /api/form-submissions
┌──────────────────┐
│  Strapi API      │
│  • validation    │
│  • rate limiting │
│  • persistence   │
│  • email notification (optional)
└──────────────────┘
```

Why Strapi API (instead of an external form service):
- The CMS already runs on the VPS — no additional cost
- Submissions are stored in the same database and visible in the admin panel
- No dependency on foreign services

## Payments: YooKassa Integration

The current site uses YooKassa (ЮKassa) for online payments.
This integration is preserved in the new architecture.

```
Visitor clicks "Make Payment"
       │
       ▼
Payment modal (React island)
  • Select program
  • Enter name / email / amount
       │
       ▼ create payment link
┌──────────────────┐
│  YooKassa API    │
│  (server-side)   │
│  • create payment with description
│  • return confirmation_url
└────────┬─────────┘
         │ redirect
         ▼
┌──────────────────┐
│  YooKassa        │
│  checkout page   │
│  (hosted by      │
│   YooKassa)      │
└──────────────────┘
```

Payment details (who paid, for what program) are tracked
within YooKassa's dashboard — not stored in the site database.
No webhook handling or payment status tracking required on our side.

**Supported payment methods:**
- Cards issued in RF: Visa, Mastercard, Mir, JCB
- CIS cards: APRA (Abkhazia), BELKART (Belarus), Express Pay (Tajikistan)

**Implementation:** a single server-side endpoint that calls YooKassa API
to create a payment and returns the redirect URL. ~50 lines of code.
Can be a Strapi custom route or a standalone serverless function on the VPS.
YooKassa is a Russian service (yookassa.ru) — complies with the RF-only constraint.

## Environments

```
Development (developer's Mac)
├── Strapi + SQLite (local DB, safe to break)
├── Astro dev server
└── Schema changes and new features tested here first

        │ code ready → git push
        ▼

VPS (production)
├── Nginx
│   ├── ikpk.su         → /var/www/production/   (manual deploy trigger)
│   └── staging.ikpk.su → /var/www/staging/       (auto-deploy from main)
├── Strapi + PostgreSQL (single instance, single DB)
└── Schema migrations: backup → apply → verify (rollback from backup)
```

**Why single Strapi + single DB:**
- Staging tests code (templates, components, new features), not content
- Content is the same in both environments — no sync needed
- Schema changes are rare (~once per few months), handled via backup → migrate
- Two Strapi instances would add complexity disproportionate to the project scale

## Content Update Flow

```
Content manager
       │
       ▼
┌──────────────────┐
│  Strapi          │
│  admin panel     │  https://<CMS_HOST>/admin
│  (in browser)    │
└────────┬─────────┘
         │
         │ save
         ▼
┌──────────────────┐     webhook      ┌──────────────┐
│  Strapi API      │────────────────▶│  GitHub       │
│  (database)      │                  │  Actions      │
└──────────────────┘                  └──────┬───────┘
                                             │
                                      1. astro build (~5 sec)
                                      2. rsync → VPS (~10 sec)
                                             │
                                             ▼
                                      ┌──────────────┐
                                      │  Nginx       │
                                      │  (updated    │
                                      │  static files│
                                      └──────┬───────┘
                                             │
                                             ▼
                                      ┌──────────────┐
                                      │  Visitors    │
                                      │  see the     │
                                      │  updates     │
                                      └──────────────┘
```

**Time breakdown from save to publish:**

| Stage | Time |
|-------|------|
| Strapi webhook → GitHub Actions trigger | ~10–30 sec |
| `npm ci` (cached deps) | ~15–30 sec |
| `astro build` (~253 pages) | ~5–10 sec |
| `rsync` output to VPS | ~5–15 sec |
| **Total** | **~1–2 min** |

**Safety net:** nightly rebuild via cron (GitHub Actions scheduled) in case
a webhook is missed. Manual trigger available through GitHub Actions UI.

## Target Performance Metrics

| Metric | Current site | New site | Improvement |
|--------|-------------|----------|-------------|
| Lighthouse Performance (mobile) | 36–56 | ≥ 85 | **+50–130%** |
| LCP (mobile) | 8.6–9.8 s | ≤ 2.5 s | **3–4×** |
| TBT (mobile) | 290–2070 ms | ≤ 200 ms | **1.5–10×** |
| TTFB | 360–1130 ms | ≤ 300 ms | **Nginx + Russia** |
| JS bundle | ~500 KB (every page) | 0–50 KB (islands only) | **10–25×** |

TTFB improves because: (1) static files served by Nginx with no backend involved,
(2) the server is located in Russia, closer to the target audience. At a peak load
of 1–5 rps, a CDN is not required.

**Scaling (if needed):** should traffic grow by an order of magnitude,
a Russian CDN (Selectel CDN, Yandex Cloud CDN, G-Core Labs) can be added
without changing the architecture — Nginx already serves static files and the CDN
would sit in front of it. For the CIS audience (Belarus, Kazakhstan), TTFB from a
Moscow VPS is ~30–80 ms, well within the ≤ 300 ms target with ample margin.

## Benefits of the New Solution

### For visitors
- Pages load 3–4× faster
- Works even on slow mobile connections
- Site remains accessible even when the CMS is down (Nginx serves static files)
- Better search engine indexing (SEO)

### For the content manager
- Standard CMS with an intuitive interface (no custom code)
- WYSIWYG editor for articles
- Manage seminars, schedules, and teachers through forms
- Seminar applications are visible directly in the CMS
- Access roles (who can edit what)

### For the owner
- No vendor lock-in to a specific developer (standard stack)
- Frontend and CMS can be changed independently
- Everything is hosted in Russia — no sanctions or blocking risks
- Low hosting cost (~900–1200 RUB/month for VPS)
- Automatic database backups

## Site Search (Pagefind)

```
astro build
     │
     ▼
┌──────────────────┐
│  ~253 HTML files  │
└────────┬─────────┘
         │
   pagefind (indexing)
         │
         ▼
┌──────────────────┐     ┌──────────────────┐
│  Search          │     │  Visitor         │
│  index (~50 KB)  │────▶│  enters a query  │
│  (on server)     │     │  in the browser  │
└──────────────────┘     └──────────────────┘

Everything runs in the browser. No backend needed.
```

**Capabilities:**
- Full-text search across all ~253 pages
- Typo tolerance (fuzzy matching, 1–2 characters)
- Russian language support
- Size: ~20 KB JS + ~50 KB index (loaded on demand)
- Speed: results in ~10 ms
- Cost: free

## Data Model (10 Entities)

```
Institute (3)
  └── CourseGroup (26)
        └── Seminar (115)
              ├── Teacher (26)  [M:N]
              └── ScheduleEntry (schedule)

Article (68)
VideoPlaylist (6)
News (news)
Promotion (promotions)
Page (static pages: payment, contacts, institutional info…)
FormSubmission (seminar applications, subscriptions)
```

Every entity with a public page has SEO fields:
- `seo_title`, `seo_description`, `og_image`, `noindex`
