# Current Solution Architecture (ikpk.su)

## Overview

The current website is a **fully custom-built** application on a JavaScript stack.
Both the frontend and backend are written from scratch, without using any off-the-shelf CMS.

## Technology Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Frontend | Next.js (React) | SSG/SSR — static site generation and server-side rendering |
| Backend | Node.js + Express | REST API for data and admin panel |
| Database | PostgreSQL (presumed) | Content storage |
| Media storage | Yandex Cloud Storage | Images, PDF documents |
| Hosting | VPS/Cloud | Single server for both frontend and backend |

> **Assumption:** the database type was inferred indirectly — from Express API
> patterns and the typical stack of Next.js projects. There is no direct confirmation
> (the API is behind authentication). Requires verification once server access is obtained.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    VPS / Cloud                       │
│                                                     │
│  ┌──────────────┐     ┌──────────────────────────┐  │
│  │  Next.js     │────▶│  Express API (Node.js)   │  │
│  │  (SSG/SSR)   │     │                          │  │
│  │              │     │  /api/institutes    (200) │  │
│  │  Pages:      │     │  /api/articles     (401) │  │
│  │  - Home      │     │  /api/seminars     (401) │  │
│  │  - Institutes│     │  /api/teachers     (401) │  │
│  │  - Seminars  │     │  /api/promotions   (401) │  │
│  │  - Articles  │     │  /api/news         (401) │  │
│  │  - etc.      │     │  /api/videos       (401) │  │
│  │              │     │  /api/payments     (401) │  │
│  └──────┬───────┘     └──────────┬───────────────┘  │
│         │                        │                   │
│         │                        ▼                   │
│         │             ┌──────────────────┐           │
│         │             │    Database      │           │
│         │             │  (PostgreSQL?)   │           │
│         │             └──────────────────┘           │
│         │                                            │
│         ▼                                            │
│  ┌──────────────┐     ┌──────────────────────────┐  │
│  │  Visitors    │     │  Custom admin panel       │  │
│  │  (browser)   │     │  (behind authentication)  │  │
│  └──────────────┘     └──────────────────────────┘  │
│                                                     │
│              ┌─────────────────────────┐             │
│              │  Yandex Cloud Storage   │             │
│              │  (images, PDF)          │             │
│              └─────────────────────────┘             │
└─────────────────────────────────────────────────────┘
```

## Content Update Flow

```
Content manager
       │
       ▼
┌──────────────────┐     ┌──────────────┐     ┌──────────────┐
│  Custom          │────▶│  Express API │────▶│  Database    │
│  admin panel     │     │  (Node.js)   │     │              │
│  (in browser)    │     └──────────────┘     └──────┬───────┘
└──────────────────┘                                  │
                                                      │
                         ┌──────────────┐             │
                         │  Next.js     │◀────────────┘
                         │  rebuild     │
                         │  (SSG)       │
                         └──────┬───────┘
                                │
                                ▼
                         ┌──────────────┐
                         │  Visitors    │
                         │  see the     │
                         │  updates     │
                         └──────────────┘
```

## Characteristics

**Performance (Lighthouse, mobile):**
- Performance: 36–56 out of 100
- LCP: 8.6–9.8 seconds
- TBT: 290–2070 ms
- JS bundle: ~500 KB+

**Number of pages:** 253 (per sitemap.xml)

**Content:**
- 3 institutes, 26 course groups, ~115 seminars
- 26 instructors
- 68 articles
- 6 video playlists
- 8 static pages (payment, contacts, etc.)

## Risks and Issues

1. **Custom code** — can only be maintained by a developer familiar with the codebase
2. **Poor performance** — heavy Next.js JS bundle on every page
3. **Monolith** — frontend and backend are tightly coupled; one cannot be replaced without the other
4. **No standard CMS** — if the current developer is unavailable, content editing becomes difficult
5. **Search depends on the server** — if the backend is down, search does not work
6. **Missing security headers** — HSTS, CSP, X-Frame-Options are not configured
