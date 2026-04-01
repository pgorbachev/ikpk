# Functional Parity Checklist — ikpk.su Rebuild

> **Purpose:** Go-live gate. Every item must pass before DNS switch.
> **Source of truth:** Production site https://ikpk.su as of March 2026.
> **Stack reference:** Next.js SSR → Astro SSG + Strapi CMS (see `rebuild_plan.md`)

---

## 1. Global — Header & Navigation

- [ ] **Logo** — ИКПК logo in header, links to `/`
- [ ] **Phone number** — `+7 (812) 646-54-50` displayed in header, clickable `tel:` link
- [ ] **Main menu** — 15 items in exact order, grouped under sections:
  1. Главная → `/`
  2. Акции и скидки → `/aktsii-i-skidki`
  3. Магазин → `https://kinezio.shop/` (external, opens new tab)
  4. Институт клинической прикладной кинезиологии → `/institut-klinicheskoy-prikladnoy-kineziologii` (group: Образование)
  5. Институт Апледжера → `/institut-apledzhera` (group: Образование)
  6. Институт Барраля → `/institut-barralya` (group: Образование)
  7. Расписание и цены → `/raspisanie-i-tseny` (group: Образование)
  8. Оплата → `/oplata` (group: Образование)
  9. Статьи → `/statyi` (group: Публикации)
  10. Видео → `/video` (group: Публикации)
  11. Фото → `https://disk.yandex.ru/d/8Xr5NSBO0wFUkQ` (external, group: Публикации)
  12. Сведения об образовательной организации → `/svedeniya-ob-obrazovatelnoy-organizatsii` (group: Информация)
  13. Сотрудничество с нами → `/sotrudnichestvo-s-nami` (group: Информация)
  14. Медицинский центр → `https://mudriydoctor.ru/` (external, group: Информация)
  15. Контакты → `/kontakty` (group: Информация)
- [ ] **Menu grouping** — items visually grouped under: Образование, Публикации, Информация
- [ ] **Mobile hamburger menu** — responsive toggle, same 15 items
- [ ] **Active page highlighting** in navigation

## 2. Global — Footer

- [ ] **Footer nav — "Обучение" column:**
  - Институт клинической прикладной кинезиологии → `/institut-klinicheskoy-prikladnoy-kineziologii`
  - Институт Апледжера → `/institut-apledzhera`
  - Институт Барраля → `/institut-barralya`
  - Расписание и цены → `/raspisanie-i-tseny`
  - Оплата → `/oplata`
- [ ] **Footer nav — "Компания" column:**
  - О нас → `/svedeniya-ob-obrazovatelnoy-organizatsii`
  - Документы → `/svedeniya-ob-obrazovatelnoy-organizatsii?section=3`
  - Контакты → `/kontakty`
  - Медицинский центр → `https://mudriydoctor.ru/` (external)
  - Магазин → `https://kinezio.shop/` (external)
  - Карта сайта → `/sitemap`
- [ ] **Social media icons** — 6 links, each opening in new tab:
  1. ВКонтакте → `https://vk.com/clubikpk`
  2. YouTube → `https://www.youtube.com/user/TheKinesiology`
  3. Rutube → `https://rutube.ru/channel/30422569/`
  4. Instagram → `https://www.instagram.com/ikpk812/`
  5. Facebook → `https://www.facebook.com/prikladnaya.kineziologiya/`
  6. Telegram → `https://t.me/ikpk_spb`
- [ ] **Copyright / legal text** in footer

## 3. Global — Newsletter Subscription (all pages)

- [ ] **"Подпишитесь на наши новости" section** — appears on every page before footer
- [ ] **Email input field** + submit button
- [ ] **Consent checkbox** — "Я согласен с обработкой персональных данных и политикой конфиденциальности"
- [ ] **Privacy policy link** → PDF on Yandex Cloud Storage (`storage.yandexcloud.net/ikpk-image/terms/...`)
- [ ] **Form submission** — sends email to backend/API, shows success/error feedback
- [ ] **Validation** — email format, consent required

## 4. Global — Analytics & Tracking

- [ ] **Yandex.Metrika** — counter ID `39506315`, loaded on all pages
- [ ] **Mail.ru Top** — counter ID `3752684`, with `<noscript>` pixel fallback (`https://top-fwz1.mail.ru/counter?id=3752684;js=na`)
- [ ] **Both counters fire on SPA navigation** (if using client-side routing)

## 5. Global — Theme & Accessibility

- [ ] **Theme support** — light/dark/system theme switching via `localStorage('theme')`
- [ ] **Accessibility class** — `accessibility` class on `<html>` for accessibility mode
- [ ] **`lang="ru"`** on `<html>` element
- [ ] **`charset="utf-8"`** meta tag
- [ ] **Viewport meta** — `width=device-width, initial-scale=1.0`

## 6. Global — Structured Data (JSON-LD)

- [ ] **SiteNavigationElement ItemList** — main nav schema on all pages
- [ ] **Footer navigation ItemList** — secondary nav schema on all pages
- [ ] **Social links ItemList** — social media schema on all pages
- [ ] **Organization schema** on contacts page (name, address, telephone, email, sameAs, departments, subOrganization)
- [ ] **BreadcrumbList schema** on course group and seminar pages
- [ ] **NewsArticle schema** on homepage (news items)

---

## 7. Homepage (`/`)

### 7.1 Hero Section
- [ ] **Heading** — "Институт клинической прикладной кинезиологии"
- [ ] **Subheading text** — 20+ years of postgraduate education, Upledger & Barral partnership
- [ ] **CTA button** — "Записаться на обучение" → `/raspisanie-i-tseny`

### 7.2 Advantages Section ("Наши преимущества")
- [ ] **6 advantage cards**, each with title + description:
  1. Наш многолетний опыт в образовании
  2. Сотрудничество с зарубежными институтами
  3. Настоящие преподаватели — ключ к успеху
  4. Документы об образовании для наших студентов
  5. Издательство медицинской литературы
  6. Практика в нашем медицинском центре

### 7.3 CTA Block (mid-page)
- [ ] **"Готовы к нам присоединиться?"** text block
- [ ] **CTA button** — "Записаться на обучение" → `/raspisanie-i-tseny`

### 7.4 Approach Section ("Наш подход к обучению")
- [ ] **Description text** about practical skill development
- [ ] **CTA button** — "Записаться на обучение" → `/raspisanie-i-tseny`

### 7.5 Statistics Section
- [ ] **3 counters** (animated or static):
  - `14 000+` — специалистов обучили
  - `> 20 лет` — обучаем новых специалистов
  - `1 500+` — получили государственную аккредитацию

### 7.6 News Section ("Новости")
- [ ] **4 news cards**, each with:
  - Thumbnail image (from Yandex Cloud Storage via `/_next/image`)
  - Title (headline)
  - Date (formatted, e.g., "23 сент., 2024")
  - Description text (HTML allowed)
- [ ] **News items link to external URLs** (WB, Ozon, medshop, promotions page — not internal `/news/{id}` pages)
- [ ] **News items sourced from CMS** (dynamic content, 4 items with priority ordering)

---

## 8. Institute Pages (`/institut-*`)

Three institutes share the same page template:

### 8.1 Институт клинической прикладной кинезиологии (`/institut-klinicheskoy-prikladnoy-kineziologii`)
- [ ] **Page heading** — institute name
- [ ] **Description text** — rich text about the institute
- [ ] **"Почему выбирают ИКПК"** — 4 bullet points with emoji icons
- [ ] **Quote/callout block** — promotional text
- [ ] **Course group cards** — list of programs (linked to course group pages)
- [ ] **Teachers section** — if present on this institute
- [ ] **Additional info (rich text)** — "Дополнительная информация" section with detailed SEO content

### 8.2 Институт Апледжера (`/institut-apledzhera`)
- [ ] **Page heading + description text**
- [ ] **Institute logo image** (Upledger Institute logo)
- [ ] **8 course group cards**, each with:
  - Thumbnail image
  - Title (program name)
  - Link to course group page
  - Listed in order: Краниосакральная терапия, Применение принципов акупунктуры, Иммунный ответ, Долголетие, Педиатрия/акушерство/новорожденные, Мозг, Специализированные, Вебинары и межсеминарские встречи
- [ ] **Teachers section** — "Преподаватели" heading with teacher cards:
  - Photo (from Yandex Cloud Storage)
  - Full name + credentials
  - Short bio (truncated)
  - Link to teacher profile page → `/institut-apledzhera/prepodavatel/{id}`
- [ ] **Training scheme** — "Схема обучения в институте Апледжера"
  - Link to external Upledger site: `https://www.upledger.com/therapies/courses.php`
  - PDF download link: `/api/upload/file/{uuid}`
- [ ] **Additional info** — rich text SEO content (course overview, benefits, who it's for, how to start)

### 8.3 Институт Барраля (`/institut-barralya`)
- [ ] **Page heading + description text** (Jean-Pierre Barral bio)
- [ ] **6 technique descriptions** — Висцеральные, Продвинутые висцеральные, Невральные, Техники выслушивания, Новый мануальный подход к суставам, Специализированные
- [ ] **Who it's for section** — target audience description
- [ ] **Course group cards** — list of course groups with images
- [ ] **Teachers section** — teacher cards
- [ ] **Additional info** — rich text

---

## 9. Course Group Pages (depth 2: `/institut-*/program-slug`)

Example: `/institut-apledzhera/kraniosakralnaya-terapiya`

- [ ] **Breadcrumb navigation** — Home > Institute > Course Group
- [ ] **BreadcrumbList JSON-LD schema**
- [ ] **Page heading** — course group name (e.g., "Краниосакральная терапия")
- [ ] **Rich text description** — detailed program info (multiple sections with headings)
- [ ] **Section content** — includes:
  - "Почему врачам полезно обучение" — benefits list
  - "Как проходит обучение" — step-by-step seminar progression (CST-1, CST-2, SER-1, SER-2, ADV-1)
  - "Что вы получите по окончании обучения" — certificates, IAHP registry
- [ ] **Seminar list** — if seminars exist under this course group, shown as cards
- [ ] **No images in course group list variant** — some course groups list seminars without thumbnails (title-only list with arrows)

---

## 10. Seminar Pages (depth 3: `/institut-*/program-slug/seminar-slug`)

Example: `/institut-apledzhera/kraniosakralnaya-terapiya/kraniosakralnaya-terapiya-2`

- [ ] **Breadcrumb navigation** — Home > Institute > Course Group > Seminar
- [ ] **BreadcrumbList JSON-LD schema**
- [ ] **Seminar title** (e.g., "CST-2: Краниосакральная терапия. Уровень 2")
- [ ] **Rich text body** — full seminar description
  - What students will learn (bulleted list)
  - Prerequisites / mandatory conditions (link to prerequisite seminar)
  - Video announcement link (external: Rutube)
- [ ] **Schedule status** — one of:
  - Upcoming dates with details (date range, city, hours)
  - "К сожалению, данный курс, в настоящий момент еще не запланирован." message
- [ ] **Scheduled event card** (when dates exist):
  - Event image
  - Seminar type badge (e.g., "Вебинар", "Семинар практикум", "Семинар на согласовании", "Маммологические техники")
  - Title
  - Teacher/author with link to profile
  - Institute name
  - Program name
  - Date range + duration (e.g., "02.04.2026 - 05.04.2026 - 4 дня (36 часов)")
  - City (Москва / Санкт-Петербург / Онлайн)
- [ ] **CTA / registration mechanism** — link or button to register/enroll (currently redirects to schedule page or external Telegram)

---

## 11. Teacher Profile Pages (`/institut-*/prepodavatel/{id}`)

Example: `/institut-apledzhera/prepodavatel/63`

- [ ] **Teacher photo** — large image from Yandex Cloud Storage
- [ ] **Full name with credentials** (e.g., "Шрайнер Валерий Эдуардович, MD, CST-D")
- [ ] **Institute affiliation** (e.g., "Институт Апледжера")
- [ ] **Number of taught programs** (e.g., "Преподаваемые направления: 6")
- [ ] **"О преподавателе" section** — bullet list of roles/certifications
- [ ] **Detailed bio** — chronological education and certifications timeline
- [ ] **Specialization list** — "С чем работает" — bulleted list of conditions/specialties

---

## 12. Schedule & Prices (`/raspisanie-i-tseny`)

- [ ] **Page displays full list of upcoming events** — sorted chronologically
- [ ] **Each event card contains:**
  - Event image (from Yandex Cloud Storage)
  - Optional badge/label (e.g., "Вебинар", "Семинар практикум", "Семинар на согласовании", "Маммологические техники")
  - Seminar title
  - Teacher/author name — clickable link to teacher profile
  - Institute name
  - Program name (course group)
  - Date range with duration (e.g., "02.04.2026 - 05.04.2026 - 4 дня (36 часов)")
  - City (Москва / Санкт-Петербург / Онлайн)
- [ ] **No visible price on schedule page** — prices may be hidden or require registration
- [ ] **No visible filters or sorting UI** — events displayed as flat chronological list
- [ ] **No pagination visible** — all events rendered on single page
- [ ] **Teacher links** go to correct teacher profile under the correct institute
- [ ] **Events from all 3 institutes** are intermixed chronologically

---

## 13. Articles (`/statyi`)

### 13.1 Article List Page
- [ ] **Page heading** — "Статьи"
- [ ] **Article cards** — grid/list of articles, each with:
  - Thumbnail image
  - Title
  - Date (formatted, e.g., "13 мая, 2025")
  - Description/excerpt (truncated)
  - Link to full article

### 13.2 Individual Article Pages (`/statyi/{slug}`)
- [ ] **Article title** (h2)
- [ ] **Date + author** (e.g., "13 мар., 2025 | Шрайнер Валерий Эдуардович")
- [ ] **Rich text body** — full article content with:
  - Headings (h2, h3)
  - Bullet lists
  - Bold/italic text
  - Paragraph breaks
- [ ] **No comments section** — static article display
- [ ] **No social share buttons** visible

---

## 14. Video (`/video`)

- [ ] **Page heading** — "Видео"
- [ ] **Notice text** about YouTube instability in Russia, with links to:
  - RUTUBE channel: `https://rutube.ru/channel/30422569/videos/`
  - VK video: `https://vk.com/video/@clubikpk`
- [ ] **Video content** — client-side rendered (videos/playlists loaded via JS)
- [ ] **Video embeds/thumbnails** — if video content is displayed (may be dynamically loaded)

---

## 15. Payment (`/oplata`)

- [ ] **Page heading** — "Оплата"
- [ ] **Instructional text** — "Готовы произвести оплату за семинар?"
- [ ] **CTA text** — "Кликайте на кнопку, выбирайте направление и записывайтесь"
- [ ] **Payment flow** — client-side rendered (JS button/modal for payment selection)
- [ ] **Verify actual payment mechanism** — Telegram bot, external payment gateway, or manual bank transfer?

---

## 16. Contacts (`/kontakty`)

- [ ] **Page heading** — "Контакты"
- [ ] **Address** — Санкт-Петербург, Новочеркасский пр-т, д. 22/15, Лит А, помещение 4Н
- [ ] **Working hours** — понедельник - пятница: 10:00 - 18:00, суббота, воскресенье — выходной
- [ ] **Department contacts:**
  - Прикладная кинезиология: `+7(981) 862-94-18`, `apliedkinesiology@mail.ru`
  - Краниосакральные и остеопатические техники: `+7 (812) 646-54-50`, `info@ikpk.su`
- [ ] **"Медицинская литература" section** — contact info or link for book orders
- [ ] **"Медицинский центр" section** — `+7 (812) 646-54-60`, `https://mudriydoctor.ru`
- [ ] **Company details** — ООО «Институт клинической прикладной кинезиологии», ИНН/КПП 7811351115 / 780601001, ОГРН 5067847182651
- [ ] **Organization JSON-LD schema** with full structured data (address, phones, emails, departments, subOrganization)
- [ ] **Map embed** — Yandex Map showing office location (client-side rendered)
- [ ] **Telegram link** — `https://t.me/ikpk_spb`

---

## 17. Org Info (`/svedeniya-ob-obrazovatelnoy-organizatsii`)

- [ ] **Page heading** — "Сведения об образовательной организации"
- [ ] **Ministry badges** — two clickable logos:
  - Министерство просвещения → `https://edu.gov.ru/`
  - Министерство науки и высшего образования → `https://minobrnauki.gov.ru/`
- [ ] **Tab/section navigation** — `?section=3` parameter for "Документы" section
- [ ] **Content sections** — tabbed or expandable (client-side rendered):
  - General info about educational organization
  - Documents section (accessible via `?section=3`)
  - Potentially more sections (structure, education programs, etc.)
- [ ] **Document downloads** — PDF links if present

---

## 18. Promotions (`/aktsii-i-skidki`)

- [ ] **Page heading** — "Акции и скидки"
- [ ] **Two sections:**
  - "Институт:" — promotions for the educational institute
  - "Магазин" — promotions for the book shop
- [ ] **Promotion cards** — dynamically loaded (client-side), may include:
  - Title
  - Description
  - Image
  - Active/expired status

---

## 19. Collaboration (`/sotrudnichestvo-s-nami`)

- [ ] **Page heading** — "Сотрудничество с нами"
- [ ] **Description text** — invitation for collaboration
- [ ] **Two collaboration directions:**
  1. **Обучение** — 3 linked cards to institute pages:
     - ИКПК programs → `/institut-klinicheskoy-prikladnoy-kineziologii`
     - Upledger programs → `/institut-apledzhera`
     - Barral programs → `/institut-barralya`
  2. **Медицинская литература** — wholesale book purchasing
     - Distributor info: ИП Пилявский Д.С.
     - Link to `https://medshop.ikpk.su/`
- [ ] **CTA button** — "Готовы к сотрудничеству?" with form trigger
- [ ] **Collaboration form** — (client-side rendered modal/form)
- [ ] **4 advantage cards:**
  - Взаимодействие с зарубежными институтами
  - Высококвалифицированных преподавателей
  - Документы об образовании
  - Скидки на литературу
- [ ] **External links:**
  - IAHE registry → `https://www.iahe.com/team/international.php`
  - НМО portal → `https://edu.rosminzdrav.ru/specialistam/obshchaja-informacija/`
  - medshop.ikpk.su → `https://medshop.ikpk.su/`

---

## 20. Sitemap (`/sitemap`)

- [ ] **HTML sitemap page** — renders sitemap for users (currently minimal: phone number only visible)
- [ ] **Dynamic content** — likely lists all site pages (client-side rendered)

---

## 21. 404 Page

- [ ] **Custom 404 page** — returns HTTP 404 status code
- [ ] **Useful navigation** — link back to homepage or navigation

---

## 22. Technical — SEO

### 22.1 Meta Tags & Open Graph
- [ ] **Unique `<title>`** per page
- [ ] **Unique `<meta name="description">`** per page
- [ ] **Open Graph tags** — og:title, og:description, og:image, og:url, og:type
- [ ] **Twitter card tags** if present
- [ ] **Canonical URL** — `<link rel="canonical">` on every page

### 22.2 robots.txt
- [ ] **robots.txt** at `/robots.txt` with rules:
  - Allow: `*.css`, `*.png`, `*.jpeg`, `*.jpg`, `*.js`
  - Disallow: `*.pdf`, `*?`, `*utm_`, `*?query=`
  - Clean-Param: `yclid`, `gclid`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`

### 22.3 XML Sitemap
- [ ] **sitemap.xml** at `/sitemap.xml`
- [ ] Contains all public URLs with correct `<priority>` values:
  - Homepage: 1.0
  - Institute pages: 1.0
  - Course groups: 0.6
  - Seminars: 0.6
  - Schedule: 0.5
  - Payment: 0.5
  - Articles: 0.6
  - Video: 0.6
  - Static pages: 0.4
- [ ] **`<lastmod>`** dates accurate for dynamic content

### 22.4 URL Structure
- [ ] **All existing URLs preserved 1:1** (no slug changes)
- [ ] **301 redirects** for any URLs that change
- [ ] **Hierarchy:**
  - `/institut-{slug}` — institute page
  - `/institut-{slug}/{course-group-slug}` — course group
  - `/institut-{slug}/{course-group-slug}/{seminar-slug}` — seminar
  - `/institut-{slug}/prepodavatel/{id}` — teacher profile
  - `/statyi/{slug}` — article
  - News items — link to external URLs (no internal `/news/{id}` pages exist)

### 22.5 JSON-LD Structured Data
- [ ] **All existing schemas preserved** (see Section 6)
- [ ] **No schema validation errors** (test with Google Rich Results Test)

---

## 23. Technical — Performance

### 23.1 Baseline Scores (Lighthouse, current site)
| Page | Device | Performance | Accessibility | Best Practices | SEO |
|------|--------|-------------|---------------|----------------|-----|
| Home | Desktop | 76 | 92 | 73 | 92 |
| Home | Mobile | 51 | 92 | 73 | 92 |

### 23.2 Targets (must meet or exceed)
- [ ] **LCP (Largest Contentful Paint)** ≤ 2.5s on mobile
- [ ] **FID / INP (Interaction to Next Paint)** ≤ 200ms
- [ ] **CLS (Cumulative Layout Shift)** ≤ 0.1
- [ ] **Lighthouse Performance** ≥ 80 desktop, ≥ 70 mobile (improvement over current)
- [ ] **Lighthouse SEO** ≥ 95
- [ ] **Lighthouse Accessibility** ≥ 95
- [ ] **Lighthouse Best Practices** ≥ 90

### 23.3 Image Optimization
- [ ] **Next/Image equivalent** — responsive images with WebP, srcset, lazy loading
- [ ] **Images served from Yandex Cloud Storage** (`storage.yandexcloud.net/ikpk-image/...`)
- [ ] **Image optimization proxy** — resizing/format conversion (currently via `/_next/image`)

---

## 24. Technical — Infrastructure

- [ ] **HTTPS everywhere** — valid SSL certificate
- [ ] **`www` → non-www` redirect** (or vice versa, match current)
- [ ] **HTTP/2 or HTTP/3** support
- [ ] **Gzip/Brotli compression** for text assets
- [ ] **Cache headers** — proper caching for static assets
- [ ] **CDN** for static assets

---

## 25. Technical — Client-Side Features

### 25.1 Image Loading
- [ ] **Lazy loading** for below-fold images
- [ ] **Blur placeholder / LQIP** for images during load (Next.js behavior)

### 25.2 Client-Side Navigation
- [ ] **SPA-like navigation** (if using View Transitions or client-side routing)
- [ ] **Full page reload fallback** — all pages work without JS (SSG)

### 25.3 Theme Switcher
- [ ] **Dark/Light/System** mode toggle persisted in `localStorage`
- [ ] **No FOUC (Flash of Unstyled Content)** — theme applied before render

---

## 26. External Integrations

- [ ] **Yandex Cloud Object Storage** — all media hosted at `storage.yandexcloud.net/ikpk-image/`
- [ ] **Yandex.Disk** — photo gallery link: `https://disk.yandex.ru/d/8Xr5NSBO0wFUkQ`
- [ ] **kinezio.shop** — external shop link in nav + footer
- [ ] **medshop.ikpk.su** — book shop (distributor site)
- [ ] **mudriydoctor.ru** — medical center link in nav + footer + contacts
- [ ] **Yandex.Metrika** — analytics (counter 39506315)
- [ ] **Mail.ru Top** — analytics (counter 3752684)
- [ ] **Telegram channel** — `https://t.me/ikpk_spb`
- [ ] **VK group** — `https://vk.com/clubikpk`
- [ ] **YouTube channel** — `https://www.youtube.com/user/TheKinesiology`
- [ ] **Rutube channel** — `https://rutube.ru/channel/30422569/`
- [ ] **IAHP registry** — `https://www.iahe.com/team/international.php`
- [ ] **Upledger Institute (USA)** — `https://www.upledger.com/therapies/courses.php`
- [ ] **НМО Минздрава** — `https://edu.rosminzdrav.ru/`
- [ ] **Министерство просвещения** — `https://edu.gov.ru/`
- [ ] **Министерство науки** — `https://minobrnauki.gov.ru/`

---

## 27. Content — Data Completeness

- [ ] **3 institute pages** with descriptions, logos, course lists, teacher lists
- [ ] **~25 course group pages** (all from sitemap.xml)
- [ ] **~50+ seminar pages** (all from sitemap.xml, depth 3 URLs)
- [ ] **Teacher profiles** — all teachers with photos, bios, credentials
- [ ] **Articles** — all published articles with full text, images, dates, authors
- [ ] **News items** — all 4+ news entries with images, dates, descriptions
- [ ] **Promotions** — all active promotions for institute and shop
- [ ] **Schedule entries** — all upcoming events with dates, cities, teachers, durations
- [ ] **Static pages** — Оплата, Контакты, Сведения, Сотрудничество, Ситемап

---

## 28. Content — File Assets

- [ ] **PDF downloads** — training scheme PDFs accessible via `/api/upload/file/{uuid}`
- [ ] **Privacy policy PDF** — Yandex Cloud Storage terms document
- [ ] **All images migrated** — from `storage.yandexcloud.net/ikpk-image/media/...`
- [ ] **Static images** — logos (Upledger Institute, ministry badges)

---

## 29. Edge Cases & Known Issues

- [x] **`/news/{id}` URLs** — RESOLVED: news items link to external URLs (WB, Ozon, medshop, promotions), not internal pages. No `/news/{id}` routes needed.
- [ ] **Video page empty without JS** — video content is entirely client-side rendered. Ensure SSR/SSG renders at minimum the notice text and fallback links.
- [ ] **Payment page minimal content** — most content is client-side. Verify what the actual payment flow is (Telegram bot? Modal? Bank transfer instructions?)
- [ ] **Promotions page minimal content** — promotions are client-side loaded. Ensure SSG pre-renders active promotions.
- [ ] **Org info sections** — `?section=3` parameter switches tab/view. Ensure URL-based section navigation works.
- [ ] **Sitemap HTML page** — currently renders minimal content. May be entirely client-side.
- [ ] **Schedule page** — no visible filters, but confirm if filtering existed and was removed or never existed.
- [ ] **No search functionality** — confirm no search is needed.
- [ ] **No user authentication/login** — confirm no student portal on ikpk.su.
- [ ] **No cookie consent banner** — confirm GDPR/Russian data law compliance is handled elsewhere.
- [ ] **No chat widget** — confirm no live chat is needed.

---

## 30. Pre-Launch Checklist

- [ ] All sections above pass ✅
- [ ] **Full URL map validated** — every URL in sitemap.xml returns 200
- [ ] **301 redirects tested** — any changed URLs redirect correctly
- [ ] **Mobile responsive** — all pages tested on iPhone SE (3rd gen), iPhone 14, iPad (gen 7), Galaxy A55 (Android Chrome proxy for Galaxy S21 class)
- [ ] **Cross-browser** — Playwright compat smoke: Chrome/Firefox/Safari (desktop) + iOS Safari (iPhone SE/iPhone 14/iPad) + Android Chrome; manual smoke: Yandex Browser (desktop + Android)
- [ ] **Load testing** — site handles expected traffic without degradation
- [ ] **DNS TTL lowered** 48h before switch
- [ ] **Old site backup** — snapshot preserved
- [ ] **Monitoring in place** — uptime, error rates, Core Web Vitals
- [ ] **Rollback plan documented** — can revert DNS within 5 minutes
