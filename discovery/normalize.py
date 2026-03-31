#!/usr/bin/env python3
"""
Normalize ikpk.su discovery data into entity-level exports for Strapi import,
and fix media_inventory proxy URLs to origin URLs.
"""

import json
import os
import re
import sys
from html.parser import HTMLParser
from urllib.parse import unquote, urlparse, parse_qs
from collections import defaultdict

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ENTITIES_DIR = os.path.join(BASE_DIR, "entities")
os.makedirs(ENTITIES_DIR, exist_ok=True)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_json(name):
    path = os.path.join(BASE_DIR, name)
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def save_json(name, data, subdir=None):
    if subdir:
        path = os.path.join(BASE_DIR, subdir, name)
    else:
        path = os.path.join(BASE_DIR, name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"  Saved {path} ({len(data)} items)")


# -- Text cleaning ----------------------------------------------------------

# Patterns that mark the beginning of footer/noise sections in body_text
NOISE_MARKERS = [
    "Подпишитесь на наши новости",
    "Подписаться на новости",
]

# Country list pattern — huge block of country names
COUNTRY_LIST_RE = re.compile(
    r"Интернациональный\s+Австралия\s+Австрия.*?(?:Ямайка|Япония)\s*",
    re.DOTALL,
)

def clean_body_text(text):
    """Remove footer noise, newsletter forms, country lists from body_text."""
    if not text:
        return ""

    # Remove zero-width characters
    text = text.replace("\u200c", "").replace("\u200b", "").replace("\u200d", "")

    # Cut at first noise marker
    for marker in NOISE_MARKERS:
        idx = text.find(marker)
        if idx > 0:
            text = text[:idx]
            break

    # Also remove country list if it appears before the marker was found
    text = COUNTRY_LIST_RE.sub("", text)

    # Collapse whitespace
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


# -- HTML cleaning ----------------------------------------------------------

class MainContentExtractor(HTMLParser):
    """Extract inner HTML of <main> tag, stripping nav/footer/script/style."""
    SKIP_TAGS = {"nav", "footer", "script", "style", "noscript", "iframe"}

    def __init__(self):
        super().__init__()
        self.in_main = False
        self.main_depth = 0
        self.skip_depth = 0
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag == "main":
            self.in_main = True
            self.main_depth = 1
            return
        if self.in_main:
            self.main_depth += 1
            if tag in self.SKIP_TAGS:
                self.skip_depth += 1
            if self.skip_depth == 0:
                attr_str = "".join(f' {k}="{v}"' for k, v in attrs) if attrs else ""
                self.parts.append(f"<{tag}{attr_str}>")

    def handle_endtag(self, tag):
        if tag == "main" and self.in_main and self.main_depth == 1:
            self.in_main = False
            self.main_depth = 0
            return
        if self.in_main:
            if tag in self.SKIP_TAGS and self.skip_depth > 0:
                self.skip_depth -= 1
            elif self.skip_depth == 0:
                self.parts.append(f"</{tag}>")
            self.main_depth -= 1

    def handle_data(self, data):
        if self.in_main and self.skip_depth == 0:
            self.parts.append(data)

    def get_html(self):
        return "".join(self.parts)


# Simpler regex-based approach for newsletter form removal from HTML
NEWSLETTER_HTML_RE = re.compile(
    r'<(?:div|section|form)[^>]*class="[^"]*(?:newsletter|subscribe|footer)[^"]*"[^>]*>.*?</(?:div|section|form)>',
    re.DOTALL | re.IGNORECASE,
)

def clean_body_html(html):
    """Extract main content area, remove noise elements."""
    if not html:
        return ""

    # If there's a <main> tag, extract its content
    if "<main" in html:
        extractor = MainContentExtractor()
        try:
            extractor.feed(html)
            result = extractor.get_html()
            if result.strip():
                html = result
        except Exception:
            pass  # fallback to full html

    # Remove script/style tags
    html = re.sub(r"<script[^>]*>.*?</script>", "", html, flags=re.DOTALL)
    html = re.sub(r"<style[^>]*>.*?</style>", "", html, flags=re.DOTALL)

    # Remove newsletter form sections
    html = NEWSLETTER_HTML_RE.sub("", html)

    return html.strip()


# -- URL helpers ------------------------------------------------------------

def decode_next_image_url(proxy_url):
    """Extract origin URL from /_next/image?url=...&w=...&q=... proxy URL."""
    if "/_next/image" in proxy_url:
        parsed = urlparse(proxy_url)
        params = parse_qs(parsed.query)
        if "url" in params:
            raw = unquote(params["url"][0])
            # Some are relative paths to static assets
            if raw.startswith("/"):
                return f"https://ikpk.su{raw}"
            return raw
    return proxy_url


def extract_origin_urls_from_images(images):
    """Given a list of image URLs from a page, decode and return origin URLs."""
    origins = []
    for img in (images or []):
        origin = decode_next_image_url(img)
        if origin:
            origins.append(origin)
    return origins


def get_extension(url):
    """Get file extension from URL."""
    path = urlparse(url).path
    _, ext = os.path.splitext(path)
    return ext.lstrip(".").lower() if ext else ""


# -- Entity builders --------------------------------------------------------

def build_page_lookup(pages):
    """Build dict: path -> page data."""
    return {p["path"]: p for p in pages}


def slug_from_path(path):
    """Extract last segment of path as slug."""
    return path.rstrip("/").split("/")[-1]


def legacy_id_from_path(path):
    """Convert path to legacy_id (strip leading slash)."""
    return path.lstrip("/")


def make_institute(page, order):
    return {
        "legacy_id": legacy_id_from_path(page["path"]),
        "legacy_url": page.get("url") or f"https://ikpk.su{page['path']}",
        "name": page.get("h1") or page.get("title", ""),
        "slug": slug_from_path(page["path"]),
        "seo_title": page.get("title", ""),
        "seo_description": page.get("seo_description", ""),
        "description_html": clean_body_html(page.get("body_html", "")),
        "description_text": clean_body_text(page.get("body_text", "")),
        "images": extract_origin_urls_from_images(page.get("images")),
        "order": order,
    }


def make_course_group(page, institute_path):
    return {
        "legacy_id": legacy_id_from_path(page["path"]),
        "legacy_url": page.get("url") or f"https://ikpk.su{page['path']}",
        "name": page.get("h1") or page.get("title", ""),
        "slug": slug_from_path(page["path"]),
        "institute_legacy_id": legacy_id_from_path(institute_path),
        "seo_title": page.get("title", ""),
        "seo_description": page.get("seo_description", ""),
        "description_html": clean_body_html(page.get("body_html", "")),
        "description_text": clean_body_text(page.get("body_text", "")),
        "images": extract_origin_urls_from_images(page.get("images")),
    }


def detect_seminar_status(page):
    """Check if seminar is not planned based on body text."""
    text = page.get("body_text", "")
    if "не запланирован" in text.lower():
        return "not_planned"
    return "planned"


def make_seminar(page, course_group_path):
    return {
        "legacy_id": legacy_id_from_path(page["path"]),
        "legacy_url": page.get("url") or f"https://ikpk.su{page['path']}",
        "name": page.get("h1") or page.get("title", ""),
        "slug": slug_from_path(page["path"]),
        "course_group_legacy_id": legacy_id_from_path(course_group_path),
        "seo_title": page.get("title", ""),
        "seo_description": page.get("seo_description", ""),
        "description_html": clean_body_html(page.get("body_html", "")),
        "description_text": clean_body_text(page.get("body_text", "")),
        "images": extract_origin_urls_from_images(page.get("images")),
        "status": detect_seminar_status(page),
    }


def make_teacher(page, teacher_struct):
    # Extract name from h1 or title (title has " : преподаватель..." suffix)
    name = page.get("h1") or ""
    if not name:
        name = page.get("title", "").split(":")[0].strip()

    # Find photo — usually first image or og_image
    images = extract_origin_urls_from_images(page.get("images"))
    photo = images[0] if images else (page.get("og_image") or "")
    if photo and "/_next/image" in photo:
        photo = decode_next_image_url(photo)

    return {
        "legacy_id": legacy_id_from_path(page["path"]),
        "legacy_url": page.get("url") or f"https://ikpk.su{page['path']}",
        "name": name,
        "slug": slug_from_path(page["path"]),
        "institute_legacy_id": legacy_id_from_path(teacher_struct.get("institute", "")),
        "bio_html": clean_body_html(page.get("body_html", "")),
        "bio_text": clean_body_text(page.get("body_text", "")),
        "photo": photo,
    }


def make_article(page):
    # Try to extract published date from body_text pattern "DD мес., YYYY"
    published_at = page.get("lastmod", "")

    return {
        "legacy_id": legacy_id_from_path(page["path"]),
        "legacy_url": page.get("url") or f"https://ikpk.su{page['path']}",
        "title": page.get("h1") or page.get("title", ""),
        "slug": slug_from_path(page["path"]),
        "seo_title": page.get("title", ""),
        "seo_description": page.get("seo_description", ""),
        "body_html": clean_body_html(page.get("body_html", "")),
        "body_text": clean_body_text(page.get("body_text", "")),
        "published_at": published_at,
        "image": (extract_origin_urls_from_images(page.get("images")) or [None])[0] or page.get("og_image", ""),
    }


def make_video_playlist(page):
    return {
        "legacy_id": legacy_id_from_path(page["path"]),
        "legacy_url": page.get("url") or f"https://ikpk.su{page['path']}",
        "title": page.get("h1") or page.get("title", ""),
        "slug": slug_from_path(page["path"]),
        "seo_title": page.get("title", ""),
        "seo_description": page.get("seo_description", ""),
        "description_html": clean_body_html(page.get("body_html", "")),
        "description_text": clean_body_text(page.get("body_text", "")),
        "images": extract_origin_urls_from_images(page.get("images")),
    }


def make_static_page(page):
    return {
        "legacy_id": legacy_id_from_path(page["path"]) or "homepage",
        "legacy_url": page.get("url") or f"https://ikpk.su{page['path']}",
        "title": page.get("h1") or page.get("title", ""),
        "slug": slug_from_path(page["path"]) or "homepage",
        "seo_title": page.get("title", ""),
        "seo_description": page.get("seo_description", ""),
        "body_html": clean_body_html(page.get("body_html", "")),
        "body_text": clean_body_text(page.get("body_text", "")),
        "images": extract_origin_urls_from_images(page.get("images")),
    }


# -- News extractor (from JSON-LD) -----------------------------------------

def extract_news_from_jsonld(pages):
    """Scan all pages for Article-type JSON-LD entries and treat them as news."""
    news = []
    seen_urls = set()
    for page in pages:
        for item in (page.get("json_ld") or []):
            if item.get("@type") == "Article":
                url = item.get("url") or item.get("mainEntityOfPage", "")
                if url in seen_urls:
                    continue
                seen_urls.add(url)
                news.append({
                    "legacy_id": legacy_id_from_path(page["path"]),
                    "legacy_url": url or page.get("url", ""),
                    "title": item.get("headline", page.get("h1", "")),
                    "slug": slug_from_path(page["path"]),
                    "seo_title": page.get("title", ""),
                    "seo_description": item.get("description", page.get("seo_description", "")),
                    "body_html": clean_body_html(page.get("body_html", "")),
                    "body_text": clean_body_text(page.get("body_text", "")),
                    "published_at": item.get("datePublished", page.get("lastmod", "")),
                    "modified_at": item.get("dateModified", ""),
                    "author": item.get("author", {}).get("name", "") if isinstance(item.get("author"), dict) else "",
                    "image": (item.get("image", [None]) or [None])[0] if isinstance(item.get("image"), list) else item.get("image", ""),
                    "source_page": page["path"],
                })
    return news


# -- Media inventory fixer --------------------------------------------------

YANDEX_URL_RE = re.compile(r'https?://storage\.yandexcloud\.net/[^\s"\'<>]+')

def fix_media_inventory(media_items, pages):
    """
    1. Decode proxy URLs to origin URLs
    2. Scan content_dump body_html for direct storage.yandexcloud.net URLs
    3. Deduplicate by origin URL
    """
    # origin_url -> { proxy_urls, found_on, context, extension }
    origin_map = defaultdict(lambda: {
        "proxy_urls": set(),
        "found_on": set(),
        "context": set(),
    })

    # Process existing media_inventory
    for item in media_items:
        raw_url = item["url"]
        origin = decode_next_image_url(raw_url)
        entry = origin_map[origin]
        if raw_url != origin:
            entry["proxy_urls"].add(raw_url)
        for page_path in item.get("found_on", []):
            entry["found_on"].add(page_path)
        entry["context"].add(item.get("context", "content"))

    # Scan all pages' body_html for direct yandex cloud URLs
    for page in pages:
        html = page.get("body_html", "")
        for match in YANDEX_URL_RE.findall(html):
            # Clean up trailing punctuation
            clean = match.rstrip(".,;)")
            entry = origin_map[clean]
            entry["found_on"].add(page["path"])
            entry["context"].add("content")

        # Also scan images array
        for img_url in (page.get("images") or []):
            origin = decode_next_image_url(img_url)
            if "storage.yandexcloud.net" in origin:
                entry = origin_map[origin]
                if img_url != origin:
                    entry["proxy_urls"].add(img_url)
                entry["found_on"].add(page["path"])
                entry["context"].add("content")

    # Convert to list
    result = []
    for origin_url, data in sorted(origin_map.items()):
        result.append({
            "origin_url": origin_url,
            "proxy_urls": sorted(data["proxy_urls"]),
            "found_on": sorted(data["found_on"]),
            "context": sorted(data["context"])[0] if len(data["context"]) == 1 else "mixed",
            "extension": get_extension(origin_url),
        })

    return result


# ===========================================================================
# MAIN
# ===========================================================================

def main():
    print("Loading data...")
    pages = load_json("content_dump.json")
    structure = load_json("site_structure.json")
    media_items = load_json("media_inventory.json")

    lookup = build_page_lookup(pages)
    issues = []

    # ------------------------------------------------------------------
    # 1. INSTITUTES
    # ------------------------------------------------------------------
    print("\n--- Institutes ---")
    institutes = []
    for i, inst in enumerate(structure["institutes"]):
        page = lookup.get(inst["path"])
        if page:
            institutes.append(make_institute(page, order=i + 1))
        else:
            issues.append(f"Institute page not found: {inst['path']}")
    save_json("institutes.json", institutes, subdir="entities")

    # ------------------------------------------------------------------
    # 2. COURSE GROUPS
    # ------------------------------------------------------------------
    print("\n--- Course Groups ---")
    course_groups = []
    for inst in structure["institutes"]:
        for course in inst.get("courses", []):
            page = lookup.get(course["path"])
            if page:
                course_groups.append(make_course_group(page, inst["path"]))
            else:
                issues.append(f"Course group page not found: {course['path']}")
    save_json("course_groups.json", course_groups, subdir="entities")

    # ------------------------------------------------------------------
    # 3. SEMINARS
    # ------------------------------------------------------------------
    print("\n--- Seminars ---")
    seminars = []
    planned_count = 0
    not_planned_count = 0
    for inst in structure["institutes"]:
        for course in inst.get("courses", []):
            for sem in course.get("seminars", []):
                page = lookup.get(sem["path"])
                if page:
                    seminar = make_seminar(page, course["path"])
                    seminars.append(seminar)
                    if seminar["status"] == "planned":
                        planned_count += 1
                    else:
                        not_planned_count += 1
                else:
                    issues.append(f"Seminar page not found: {sem['path']}")
    save_json("seminars.json", seminars, subdir="entities")
    print(f"  Planned: {planned_count}, Not planned: {not_planned_count}")

    # ------------------------------------------------------------------
    # 4. TEACHERS
    # ------------------------------------------------------------------
    print("\n--- Teachers ---")
    teachers = []
    for t in structure["teachers"]:
        page = lookup.get(t["path"])
        if page:
            teachers.append(make_teacher(page, t))
        else:
            issues.append(f"Teacher page not found: {t['path']}")
    save_json("teachers.json", teachers, subdir="entities")

    # ------------------------------------------------------------------
    # 5. ARTICLES
    # ------------------------------------------------------------------
    print("\n--- Articles ---")
    articles = []
    # Track article paths from structure
    article_paths = {a["path"] for a in structure["articles"]}
    for art in structure["articles"]:
        page = lookup.get(art["path"])
        if page:
            articles.append(make_article(page))
        else:
            issues.append(f"Article page not found: {art['path']}")
    save_json("articles.json", articles, subdir="entities")

    # ------------------------------------------------------------------
    # 6. VIDEO PLAYLISTS
    # ------------------------------------------------------------------
    print("\n--- Video Playlists ---")
    playlists = []
    for vp in structure["video_playlists"]:
        page = lookup.get(vp["path"])
        if page:
            playlists.append(make_video_playlist(page))
        else:
            issues.append(f"Video playlist page not found: {vp['path']}")
    save_json("video_playlists.json", playlists, subdir="entities")

    # ------------------------------------------------------------------
    # 7. NEWS (from JSON-LD Article entries)
    # ------------------------------------------------------------------
    print("\n--- News ---")
    news = extract_news_from_jsonld(pages)
    save_json("news.json", news, subdir="entities")

    # ------------------------------------------------------------------
    # 8. STATIC PAGES
    # ------------------------------------------------------------------
    print("\n--- Static Pages ---")

    # Collect all paths already assigned to other entities
    assigned_paths = set()
    for inst in structure["institutes"]:
        assigned_paths.add(inst["path"])
        for course in inst.get("courses", []):
            assigned_paths.add(course["path"])
            for sem in course.get("seminars", []):
                assigned_paths.add(sem["path"])
    for t in structure["teachers"]:
        assigned_paths.add(t["path"])
    for a in structure["articles"]:
        assigned_paths.add(a["path"])
    for vp in structure["video_playlists"]:
        assigned_paths.add(vp["path"])

    # Static pages from structure + any unassigned pages
    static_pages = []
    static_page_paths = set()
    for sp in structure["static_pages"]:
        page = lookup.get(sp["path"])
        if page:
            static_pages.append(make_static_page(page))
            static_page_paths.add(sp["path"])
        else:
            issues.append(f"Static page not found: {sp['path']}")

    # Also include pages from content_dump that are not in any category
    # (e.g. article sub-pages / reviews)
    orphan_count = 0
    for page in pages:
        if page["path"] not in assigned_paths and page["path"] not in static_page_paths:
            # These are orphan pages (reviews, sub-pages, etc.)
            orphan_count += 1

    if orphan_count:
        issues.append(f"{orphan_count} orphan pages not assigned to any entity (likely article reviews/sub-pages)")

    save_json("static_pages.json", static_pages, subdir="entities")

    # ------------------------------------------------------------------
    # TASK 2: Fix media inventory
    # ------------------------------------------------------------------
    print("\n--- Media Inventory Fix ---")
    fixed_media = fix_media_inventory(media_items, pages)
    save_json("media_inventory_fixed.json", fixed_media)

    # Count origin URLs that are yandex cloud vs static assets
    yandex_count = sum(1 for m in fixed_media if "storage.yandexcloud.net" in m["origin_url"])
    static_count = sum(1 for m in fixed_media if "/_next/static/" in m["origin_url"])
    other_count = len(fixed_media) - yandex_count - static_count

    # ==================================================================
    # SUMMARY
    # ==================================================================
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"  Institutes:       {len(institutes)}")
    print(f"  Course Groups:    {len(course_groups)}")
    print(f"  Seminars:         {len(seminars)} (planned: {planned_count}, not_planned: {not_planned_count})")
    print(f"  Teachers:         {len(teachers)}")
    print(f"  Articles:         {len(articles)}")
    print(f"  Video Playlists:  {len(playlists)}")
    print(f"  News (JSON-LD):   {len(news)}")
    print(f"  Static Pages:     {len(static_pages)}")
    print(f"  ---")
    print(f"  Media (original): {len(media_items)}")
    print(f"  Media (fixed):    {len(fixed_media)} unique origin URLs")
    print(f"    Yandex Cloud:   {yandex_count}")
    print(f"    Static assets:  {static_count}")
    print(f"    Other:          {other_count}")

    if issues:
        print(f"\n  ISSUES ({len(issues)}):")
        for issue in issues:
            print(f"    ⚠ {issue}")

    print("\nDone!")


if __name__ == "__main__":
    main()
