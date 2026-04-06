# Architecture Comparison: Current Site vs New Solution

## Summary Table

| Parameter | Current Site | New Solution |
|----------|-------------|---------------|
| **Frontend** | Next.js (React) | Astro (SSG) |
| **Backend** | Express (custom) | Strapi CMS (standard) |
| **Admin Panel** | Custom | Strapi (web interface) |
| **Search** | Server-side (Express API) | Client-side (Pagefind, in-browser) |
| **Client JS** | ~500 KB | 0–50 KB (islands) |
| **Lighthouse mobile** | 36–56 | ≥ 85 (target) |
| **LCP** | 8.6–9.8 s | ≤ 2.5 s |
| **Frontend hosting** | VPS | VPS + Nginx (static) |
| **Backend hosting** | VPS | VPS (CMS only) |
| **Media** | Yandex Cloud | Yandex Cloud (unchanged) |
| **Developer dependency** | High | Low |
| **Hosting cost** | VPS (all-in-one) | VPS (Nginx + Strapi + PostgreSQL) |

## Diagram: Current Architecture

```
    Visitor                     Content Manager
        │                            │
        ▼                            ▼
┌─────────────────────────────────────────────┐
│                 VPS / Cloud                  │
│                                             │
│   Next.js ◄──── Express API ◄──── Admin    │
│   (front)       (backend)        (custom)   │
│       │              │                      │
│       └──────┬───────┘                      │
│              ▼                              │
│          Database                           │
│                                             │
│      Yandex Cloud Storage (media)           │
└─────────────────────────────────────────────┘

         ▲ Everything on a single server
         │ Monolith — cannot scale components independently
```

## Diagram: New Architecture

```
    Visitor                     Content Manager
        │                            │
        ▼                            ▼
┌───────────────────────────────────────────────────┐
│   Russian VPS (Nginx)                             │
│                                                   │
│   Astro (static)  ◀── Strapi CMS                  │
│   HTML + CSS          • Admin panel               │
│   0–50 KB JS          • REST API                  │
│   (islands)           • PostgreSQL                │
│                                                   │
│   React islands       Yandex Cloud (media)        │
│   (forms/filters)                                 │
└───────────────────────────────────────────────────┘
                   webhook → GitHub Actions → rsync
         ▲ Separation of concerns
         │ Frontend — static, CMS — separate process
```

## Key Differences

### 1. Performance

```
Current:   Visitor ──▶ VPS ──▶ Next.js renders ──▶ ~500KB JS
                       (remote)    (slow)          (heavy)

New:       Visitor ──▶ VPS Nginx ──▶ pre-built HTML ──▶ 0–50KB JS
                       (Russia)     (instant)          (light)
```

### 2. Content Updates

```
Current:   Manager ──▶ Custom admin ──▶ API ──▶ DB ──▶ rebuild?

New:       Manager ──▶ Strapi (standard) ──▶ webhook ──▶ rebuild ──▶ Nginx
                                                         (~1–2 min)
```

### 3. Developer Dependency

```
Current:   Custom Express + custom admin panel
           │
           └──▶ Can only be maintained by the original author

New:       Strapi (open-source, documentation, community)
           + Astro (open-source, documentation, community)
           │
           └──▶ Can be maintained by any web developer
```

### 4. Search

```
Current:   Visitor ──▶ React ──▶ Express API ──▶ DB (full-text)
           If the server is down — search is unavailable

New:       Visitor ──▶ Pagefind (in-browser) ──▶ index on server
           Always works, no backend needed, ~10 ms
```

## What Is Preserved During Migration

- All 253+ URLs (1:1 mapping, 301 redirects for changed ones)
- All content (articles, seminars, instructors, schedule)
- All images (Yandex Cloud Storage — unchanged)
- Design and UX (same style, adapted for the new stack)
- Analytics (Yandex.Metrica 39506315, Mail.ru 3752684)
- SEO rankings (canonical URL, meta tags, schema markup)

## What Is Improved

- Page load speed: 3–4× faster
- SEO: full schema markup (5 JSON-LD types)
- Content management: standard CMS instead of custom
- Maintainability: standard stack, not tied to a single developer
- Security: security headers, frontend/backend separation
