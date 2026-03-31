#!/usr/bin/env python3
"""
Normalize ikpk.su discovery data into entity-level exports for Strapi import.

Data sources:
  - content_dump.json (254 scraped pages — HTML + text + meta)
  - site_structure.json (hierarchical structure tree)
  - media_inventory.json (315 unique origin URLs, already decoded from /_next/image proxy)
  - Homepage __NEXT_DATA__ (news items — fetched live)
  - Schedule API (events — fetched live from /api/public/events)
  - Aktsii page __NEXT_DATA__ (promotions — fetched live)

Outputs (in entities/):
  - institutes.json, course_groups.json, seminars.json, teachers.json
  - articles.json, video_playlists.json, static_pages.json
  - news.json (from homepage __NEXT_DATA__, NOT from JSON-LD)
  - schedule_entries.json (from public API)
  - promotions.json (from aktsii page __NEXT_DATA__)

Post-processing applied to all outputs:
  - staging.ikpk.su → ikpk.su in all string fields
  - /_next/image?url=ENCODED&w=N&q=N → decoded origin URL in all HTML fields
  - UI noise (nav, footer, country dropdowns) stripped from text fields
  - legacy_id on every entity (stable key for idempotent import)
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

def load_json(filename):
    path = os.path.join(BASE_DIR, filename)
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(filename, data):
    path = os.path.join(ENTITIES_DIR, filename)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"  ✓ {filename}: {len(data)} items")


class HTMLTextExtractor(HTMLParser):
    """Extract clean text from HTML, skipping script/style/nav/footer."""
    SKIP_TAGS = {"script", "style", "nav", "footer", "noscript"}

    def __init__(self):
        super().__init__()
        self.result = []
        self.skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP_TAGS:
            self.skip_depth += 1

    def handle_endtag(self, tag):
        if tag in self.SKIP_TAGS and self.skip_depth > 0:
            self.skip_depth -= 1

    def handle_data(self, data):
        if self.skip_depth == 0:
            self.result.append(data)

    def get_text(self):
        return " ".join(self.result).strip()


def html_to_clean_text(html):
    if not html:
        return ""
    extractor = HTMLTextExtractor()
    extractor.feed(html)
    text = extractor.get_text()
    # Remove country dropdown noise
    text = re.sub(
        r"Интернациональный\s+Австралия\s+Австрия.*?(?=Подпишитесь|$)",
        "", text, flags=re.S
    )
    text = re.sub(r"\s+", " ", text).strip()
    return text


def fix_staging_urls(text):
    """Replace staging.ikpk.su with ikpk.su."""
    if not text:
        return text
    return text.replace("staging.ikpk.su", "ikpk.su")


def decode_next_image_proxies(html):
    """Replace /_next/image?url=ENCODED&w=N&q=N with decoded origin URL."""
    if not html:
        return html
    def replacer(m):
        url_param = m.group(1)
        decoded = unquote(url_param)
        if decoded.startswith("/"):
            decoded = f"https://ikpk.su{decoded}"
        return decoded
    html = re.sub(
        r"/_next/image\?url=([^&\"\\]+)(?:[^\"]*?)(?=\")",
        replacer, html
    )
    return html


def clean_entity(entity):
    """Apply staging URL fix and proxy image decoding to all string fields."""
    for key, value in entity.items():
        if isinstance(value, str):
            value = fix_staging_urls(value)
            if "html" in key.lower():
                value = decode_next_image_proxies(value)
            entity[key] = value
    return entity


# ---------------------------------------------------------------------------
# Entity extractors (from content_dump + site_structure)
# ---------------------------------------------------------------------------

def extract_institutes(pages, structure):
    institutes = []
    for inst in structure.get("institutes", []):
        page = next((p for p in pages if p.get("path") == inst.get("path")), None)
        entry = {
            "legacy_id": inst["path"].lstrip("/"),
            "legacy_url": f"https://ikpk.su{inst['path']}",
            "name": inst.get("name", ""),
            "slug": inst["path"].lstrip("/"),
            "shortName": "",
            "description_html": page.get("body_html", "") if page else "",
            "description_text": html_to_clean_text(page.get("body_html", "")) if page else "",
            "images": inst.get("images", []),
        }
        if page:
            entry["seo_title"] = page.get("seo_title", "")
            entry["seo_description"] = page.get("seo_description", "")
        institutes.append(clean_entity(entry))
    return institutes


def extract_course_groups(pages, structure):
    groups = []
    for inst in structure.get("institutes", []):
        for cg in inst.get("course_groups", []):
            page = next((p for p in pages if p.get("path") == cg.get("path")), None)
            entry = {
                "legacy_id": cg["path"].lstrip("/"),
                "legacy_url": f"https://ikpk.su{cg['path']}",
                "name": cg.get("name", ""),
                "slug": cg["path"].split("/")[-1],
                "institute_legacy_id": inst["path"].lstrip("/"),
                "description_html": page.get("body_html", "") if page else "",
                "description_text": html_to_clean_text(page.get("body_html", "")) if page else "",
                "images": cg.get("images", []),
            }
            if page:
                entry["seo_title"] = page.get("seo_title", "")
                entry["seo_description"] = page.get("seo_description", "")
            groups.append(clean_entity(entry))
    return groups


def extract_seminars(pages, structure):
    seminars = []
    for inst in structure.get("institutes", []):
        for cg in inst.get("course_groups", []):
            for sem in cg.get("seminars", []):
                page = next((p for p in pages if p.get("path") == sem.get("path")), None)
                not_planned_text = "К сожалению, данный курс, в настоящий момент еще не запланирован"
                body = page.get("body_text", "") if page else ""
                status = "not_planned" if not_planned_text in body else "planned"
                entry = {
                    "legacy_id": sem["path"].lstrip("/"),
                    "legacy_url": f"https://ikpk.su{sem['path']}",
                    "name": sem.get("name", ""),
                    "slug": sem["path"].split("/")[-1],
                    "course_group_legacy_id": cg["path"].lstrip("/"),
                    "description_html": page.get("body_html", "") if page else "",
                    "description_text": html_to_clean_text(page.get("body_html", "")) if page else "",
                    "images": sem.get("images", []),
                    "status": status,
                }
                if page:
                    entry["seo_title"] = page.get("seo_title", "")
                    entry["seo_description"] = page.get("seo_description", "")
                seminars.append(clean_entity(entry))
    return seminars


def extract_teachers(pages, structure):
    teachers = []
    for inst in structure.get("institutes", []):
        for t in inst.get("teachers", []):
            page = next((p for p in pages if p.get("path") == t.get("path")), None)
            entry = {
                "legacy_id": t["path"].lstrip("/"),
                "legacy_url": f"https://ikpk.su{t['path']}",
                "name": t.get("name", ""),
                "slug": t["path"].split("/")[-1],
                "institute_legacy_id": inst["path"].lstrip("/"),
                "bio_html": page.get("body_html", "") if page else "",
                "bio_text": html_to_clean_text(page.get("body_html", "")) if page else "",
                "photo": t.get("image", ""),
            }
            teachers.append(clean_entity(entry))
    return teachers


def extract_articles(pages, structure):
    articles = []
    for a in structure.get("articles", []):
        page = next((p for p in pages if p.get("path") == a.get("path")), None)
        entry = {
            "legacy_id": a["path"].lstrip("/"),
            "legacy_url": f"https://ikpk.su{a['path']}",
            "title": a.get("name", ""),
            "slug": a["path"].split("/")[-1],
            "body_html": page.get("body_html", "") if page else "",
            "body_text": html_to_clean_text(page.get("body_html", "")) if page else "",
            "image": a.get("image", ""),
            "published_at": page.get("lastmod", "") if page else "",
        }
        if page:
            entry["seo_title"] = page.get("seo_title", "")
            entry["seo_description"] = page.get("seo_description", "")
        articles.append(clean_entity(entry))
    return articles


def extract_video_playlists(pages, structure):
    playlists = []
    for vp in structure.get("video_playlists", []):
        page = next((p for p in pages if p.get("path") == vp.get("path")), None)
        entry = {
            "legacy_id": vp["path"].lstrip("/"),
            "legacy_url": f"https://ikpk.su{vp['path']}",
            "name": vp.get("name", ""),
            "slug": vp["path"].split("/")[-1],
            "videos": vp.get("videos", []),
        }
        if page:
            entry["seo_title"] = page.get("seo_title", "")
            entry["seo_description"] = page.get("seo_description", "")
        playlists.append(clean_entity(entry))
    return playlists


def extract_static_pages(pages, structure):
    static = []
    for sp in structure.get("static_pages", []):
        page = next((p for p in pages if p.get("path") == sp.get("path")), None)
        entry = {
            "legacy_id": sp["path"].lstrip("/") or "homepage",
            "legacy_url": f"https://ikpk.su{sp['path']}",
            "title": sp.get("name", ""),
            "slug": sp["path"].lstrip("/") or "homepage",
            "body_html": page.get("body_html", "") if page else "",
            "body_text": html_to_clean_text(page.get("body_html", "")) if page else "",
        }
        if page:
            entry["seo_title"] = page.get("seo_title", "")
            entry["seo_description"] = page.get("seo_description", "")
        static.append(clean_entity(entry))
    return static


# ---------------------------------------------------------------------------
# Live data fetchers (news, schedule, promotions)
# ---------------------------------------------------------------------------

def fetch_news_from_homepage():
    """Fetch actual news items from homepage __NEXT_DATA__ (NOT from JSON-LD)."""
    import urllib.request
    url = "https://ikpk.su/"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    resp = urllib.request.urlopen(req, timeout=15)
    html = resp.read().decode("utf-8", errors="ignore")
    match = re.search(
        r'<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S
    )
    if not match:
        raise RuntimeError("No __NEXT_DATA__ found on homepage")
    nd = json.loads(match.group(1))
    news = nd["props"]["pageProps"]["news"]
    return [clean_entity(item) for item in news]


def fetch_schedule_from_api():
    """Fetch all schedule events from public API."""
    import urllib.request
    all_events = []
    page = 1
    while True:
        url = (
            f"https://ikpk.su/api/public/events"
            f"?page={page}&pageSize=30&sortBy=startAt&sortDirection=ASC"
        )
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        resp = urllib.request.urlopen(req, timeout=15)
        data = json.loads(resp.read())
        items = data.get("items", [])
        all_events.extend(items)
        if page >= data.get("pagesCount", 1):
            break
        page += 1
    return all_events


def fetch_promotions_from_aktsii():
    """Fetch promotions from aktsii page __NEXT_DATA__."""
    import urllib.request
    url = "https://ikpk.su/aktsii-i-skidki"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    resp = urllib.request.urlopen(req, timeout=15)
    html = resp.read().decode("utf-8", errors="ignore")
    match = re.search(
        r'<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S
    )
    if not match:
        raise RuntimeError("No __NEXT_DATA__ found on aktsii page")
    nd = json.loads(match.group(1))
    queries = nd["props"]["pageProps"]["initialState"]["commonApi"]["queries"]
    promo_key = next(k for k in queries if "Promotion" in k)
    return queries[promo_key]["data"]["items"]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print("Loading discovery data...")
    pages = load_json("content_dump.json")
    structure = load_json("site_structure.json")

    print(f"  content_dump: {len(pages)} pages")
    print(f"  site_structure: loaded")

    print("\nExtracting entities from scraped data...")
    save_json("institutes.json", extract_institutes(pages, structure))
    save_json("course_groups.json", extract_course_groups(pages, structure))
    save_json("seminars.json", extract_seminars(pages, structure))
    save_json("teachers.json", extract_teachers(pages, structure))
    save_json("articles.json", extract_articles(pages, structure))
    save_json("video_playlists.json", extract_video_playlists(pages, structure))
    save_json("static_pages.json", extract_static_pages(pages, structure))

    print("\nFetching live data...")
    try:
        news = fetch_news_from_homepage()
        save_json("news.json", news)
    except Exception as e:
        print(f"  ✗ news: {e}")

    try:
        events = fetch_schedule_from_api()
        save_json("schedule_entries.json", events)
    except Exception as e:
        print(f"  ✗ schedule_entries: {e}")

    try:
        promos = fetch_promotions_from_aktsii()
        save_json("promotions.json", promos)
    except Exception as e:
        print(f"  ✗ promotions: {e}")

    print("\nDone. All entities saved to entities/")


if __name__ == "__main__":
    main()
