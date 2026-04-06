# PRD: ikpk.su Website Rebuild

## Goal

Replace the current website (Next.js + custom Express backend) with a new stack
(Astro SSG + Strapi CMS), preserving all content and functionality.

## Users

| Role | Who | What they do |
|------|-----|--------------|
| Visitor | Physicians, students, prospective attendees | Browse courses, read articles, register for seminars |
| Content manager | IKPK staff member | Updates the schedule, adds articles, edits pages |
| Administrator | Owner / IT | Manages CMS users, deploys, monitors |

## Out of Scope

The following features are **not** part of this rebuild:

- **User accounts / authentication for visitors** — no registration, login, or personal dashboard
- **Payment tracking on the site** — payments are handled entirely by YooKassa; the site only redirects to checkout
- **CRM / student management** — enrollment tracking, certificates, and student progress live outside the site
- **Online payment gateway beyond redirect** — no webhooks, no payment status pages, no refund processing on-site
- **E-commerce / shopping cart** — the separate store (kinezio.shop) is out of scope
- **Mobile app**

The site is a **content showcase + enrollment funnel**: browse → choose → pay (redirect) → manager contacts the student offline.

## Functional Requirements

### FR-01: Training Catalog

A visitor can browse the training structure:
Institute → Course Group → Seminar.

**Acceptance criteria:**
- 3 institutes, each with its own page, list of courses, and instructors
- 26 course groups with a list of seminars
- ~115 seminars: description, duration, price, instructor, upcoming dates
- Breadcrumbs at every nesting level
- Schema.org: Course, Event on the corresponding pages

### FR-02: Schedule and Pricing

A visitor sees a summary table of all upcoming seminars with filtering.

**Acceptance criteria:**
- Table columns: date, title, institute, city, instructor, price
- Filters: by institute, by city (React island)
- Sorted by date (soonest first)
- "Register" button on each seminar
- Only active seminars (status = active)

### FR-03: Articles

A visitor reads articles by instructors and experts.

**Acceptance criteria:**
- Article list with cards (image, title, date, excerpt)
- Article detail page with rich HTML, images, sidebar
- Related articles (4 items) on the detail page
- Schema.org: Article

### FR-04: Videos

A visitor watches educational videos organized by playlist.

**Acceptance criteria:**
- Playlist listing (6 items)
- Embedded YouTube player on the playlist page
- Alternative links: RUTUBE, VK (YouTube is unreliable in Russia)

### FR-05: Search

A visitor searches across all site content.

**Acceptance criteria:**
- Search button in the header
- Full-text search across all pages (Pagefind)
- Typo tolerance (1–2 characters)
- Results: title, content type, excerpt, link
- Works without a server (client-side index)

### FR-06: Seminar Registration Form

A visitor submits an application to attend a seminar.

**Acceptance criteria:**
- Form fields: name, email, phone, selected seminar
- Field validation (email, required fields)
- Submission to Strapi REST API (`POST /api/form-submissions`)
- Submission is stored in the database and visible in the CMS admin panel
- Success confirmation / error message
- Rate limiting at the Strapi level (spam protection)

### FR-07: Newsletter Subscription

A visitor subscribes to the email newsletter.

**Acceptance criteria:**
- Form on every page (above the footer)
- Fields: email + personal-data processing consent checkbox
- Link to the privacy policy (PDF)
- Email validation, required checkbox
- Feedback: success / error

### FR-08: Static Pages

Informational pages with no interactive elements.

**Acceptance criteria:**
- Payment: FAQ accordion (payment methods, refund policy), payment button
- YooKassa integration: payment modal → create payment via API → redirect to YooKassa checkout
- No payment status tracking on site — all payment data lives in YooKassa dashboard
- Supported cards: Visa, Mastercard, Mir, JCB (RF-issued); APRA, BELKART, Express Pay (CIS)
- Contacts: 5 blocks (phone, email, address, hours, medical center), Yandex.Maps embed
- Partnership: description + CTA with contact details
- Educational organization information: accordion with sections
- Promotions and discounts: promo cards with badges

### FR-09: Navigation

**Acceptance criteria:**
- Header: logo (→ /), phone number (tel: link)
- Sidebar: 15 menu items grouped into 3 sections (Education, Publications, Information)
- Sections expand/collapse; state is persisted in localStorage
- External links: Shop, Photos, Medical Center (`target="_blank" rel="noopener noreferrer"`)
- Active state on the current page
- Mobile menu: hamburger, overlay, slide-in sidebar
- Footer: 4 columns (contacts, education, company, social media)
- Social media: VK, YouTube, RUTUBE, Instagram, Facebook, Telegram
- Breadcrumbs on all nested pages

### FR-10: Instructors

**Acceptance criteria:**
- Profile: photo, name, biography, institute affiliation
- Instructor list on the institute page
- ~26 profiles, each with its own URL

### FR-11: CMS (Content Manager)

**Acceptance criteria:**
- Web interface for editing all content types
- WYSIWYG editor for text
- Image uploads
- Schedule management (dates, prices, status)
- Roles: administrator (full access) / editor (content only, no settings)
- On save → webhook → site rebuild (≤ 5 minutes to publication)

### FR-12: Sitemap and 404

**Acceptance criteria:**
- HTML sitemap (/sitemap) — all sections, noindex
- XML sitemap (auto-generated by Astro) for search engines
- 404 page: message + links to homepage and sitemap

### FR-13: Live Chat Widget (Bitrix24)

**Acceptance criteria:**
- Bitrix24 Open Lines chat widget on all pages (floating button, bottom-right)
- Loads the existing script: `cdn-ru.bitrix24.ru/b35315886/crm/site_button/loader_2_siutnh.js`
- Deferred loading (no impact on page speed)
- No changes to the Bitrix24 portal — same operators, same settings

## Non-Functional Requirements

### NFR-01: Performance

| Metric | Target | Method |
|--------|--------|--------|
| Lighthouse Performance (mobile) | ≥ 85 | Median of 5 runs |
| LCP (mobile) | ≤ 2.5 s | Lighthouse CI |
| TBT (mobile) | ≤ 200 ms | Lighthouse CI |
| CLS | ≤ 0.1 | Lighthouse CI |
| TTFB | ≤ 300 ms (p75) | Synthetic, Moscow + Saint Petersburg |

### NFR-02: SEO

- Unique title + description on every page
- `<link rel="canonical">` on every page
- Open Graph tags (title, description, image, url, locale)
- Schema.org JSON-LD: EducationalOrganization, Course, Event, Article, BreadcrumbList
- robots.txt + XML sitemap
- 301 redirects for all changed URLs (100% URL map coverage)
- Lighthouse SEO ≥ 95

### NFR-03: Security

- HTTPS on all pages
- Security headers: HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy
- Strapi: API tokens with least-privilege access, RBAC
- Forms: client-side and server-side validation, rate limiting
- PII stored only in Strapi (not in CDN logs)

### NFR-04: Accessibility

- `lang="ru"` on `<html>`
- Semantic markup (nav, main, article, aside)
- Alt text on images
- Focus states on interactive elements
- Minimum text contrast ≥ 4.5:1
- Verification: Lighthouse Accessibility ≥ 90, axe-core (CI)

### NFR-05: Browser Compatibility

- Mobile: iOS Safari 15+, Chrome Android
- Desktop: Chrome, Firefox, Safari, Edge (last 2 versions)
- Breakpoints: 1024px, 768px, 640px, 480px

### NFR-06: Analytics

- Yandex.Metrika (ID: 39506315) — all pages, webvisor
- Mail.ru Top (ID: 3752684) — all pages
- Both counters: sync pageview queue + deferred script loading

### NFR-07: Content Update SLA

- From CMS save to live on site: ≤ 5 minutes
- Nightly rebuild as a safety net for missed webhooks
- Fallback: manual rebuild trigger via CI/CD

## Acceptance Criteria (Definition of Done)

1. All FR-01…FR-13 are implemented and verified
2. All NFR-01…NFR-07 meet their target values
3. All URLs from the current sitemap.xml (253 total) → 200 or 301
4. Build completes without errors
5. E2E tests pass (Playwright)
6. UAT completed with the content manager
