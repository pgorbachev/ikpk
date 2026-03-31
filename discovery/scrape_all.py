#!/usr/bin/env python3
"""
Full-site scraper for ikpk.su — extracts structured content from all 254 pages.
Outputs: content_dump.json, site_structure.json, media_inventory.json
"""

import json
import re
import sys
import time
from collections import defaultdict
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup, Comment

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
BASE_URL = "https://ikpk.su"
SITEMAP_URL = f"{BASE_URL}/sitemap.xml"
DELAY = 0.5  # seconds between requests
TIMEOUT = 30
OUTPUT_DIR = "/Users/pgorbachev/projects/private/ikpk/discovery"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/125.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
}

session = requests.Session()
session.headers.update(HEADERS)

# ---------------------------------------------------------------------------
# Step 1 — parse sitemap
# ---------------------------------------------------------------------------

def fetch_sitemap():
    """Return list of dicts with 'url' and optional 'lastmod'."""
    resp = session.get(SITEMAP_URL, timeout=TIMEOUT)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.content, "lxml-xml")
    entries = []
    for url_tag in soup.find_all("url"):
        loc = url_tag.find("loc")
        lastmod = url_tag.find("lastmod")
        if loc:
            entries.append({
                "url": loc.text.strip(),
                "lastmod": lastmod.text.strip() if lastmod else None,
            })
    return entries


# ---------------------------------------------------------------------------
# Step 2 — extract structured page data
# ---------------------------------------------------------------------------

def get_path(url):
    parsed = urlparse(url)
    path = parsed.path
    if not path or path == "/":
        return "/"
    return path.rstrip("/")


def get_depth(path):
    if path == "/":
        return 0
    return len([s for s in path.split("/") if s])


def extract_json_ld(soup):
    blocks = []
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            blocks.append(json.loads(script.string))
        except (json.JSONDecodeError, TypeError):
            pass
    return blocks


def extract_main_content(soup):
    """Try to find the main content area, excluding nav/header/footer."""
    # Next.js typically wraps content in <main> or a div with id="__next"
    main = soup.find("main")
    if main:
        return main

    # Try common content wrappers
    for selector in ["#__next", ".content", "#content", "article", ".page-content"]:
        el = soup.select_one(selector)
        if el:
            return el

    return soup.body if soup.body else soup


def extract_body_text(content_el):
    """Get visible text from content element, stripping nav/footer if present."""
    # Remove script, style, nav, footer, header tags from a copy
    clone = BeautifulSoup(str(content_el), "html.parser")
    for tag in clone.find_all(["script", "style", "nav", "footer", "header", "noscript"]):
        tag.decompose()
    # Remove HTML comments
    for comment in clone.find_all(string=lambda t: isinstance(t, Comment)):
        comment.extract()
    text = clone.get_text(separator=" ", strip=True)
    # Collapse whitespace
    text = re.sub(r"\s+", " ", text).strip()
    return text


def extract_images(content_el, page_url):
    """Extract all image URLs from content."""
    images = set()
    for img in content_el.find_all("img"):
        src = img.get("src") or img.get("data-src")
        if src:
            images.add(urljoin(page_url, src))
    # Also check background-image in inline styles
    for el in content_el.find_all(style=True):
        style = el["style"]
        for match in re.findall(r'url\(["\']?(.*?)["\']?\)', style):
            images.add(urljoin(page_url, match))
    return sorted(images)


def extract_internal_links(content_el, page_url):
    """Extract unique internal link paths."""
    links = set()
    for a in content_el.find_all("a", href=True):
        href = a["href"]
        if href.startswith("mailto:") or href.startswith("tel:") or href.startswith("#"):
            continue
        full = urljoin(page_url, href)
        parsed = urlparse(full)
        if parsed.netloc and parsed.netloc not in ("ikpk.su", "www.ikpk.su"):
            continue
        path = parsed.path.rstrip("/") or "/"
        links.add(path)
    return sorted(links)


def scrape_page(url, lastmod=None):
    """Fetch a single page and return structured data dict."""
    path = get_path(url)
    depth = get_depth(path)
    data = {
        "url": url,
        "path": path,
        "depth": depth,
        "title": None,
        "seo_description": None,
        "h1": None,
        "canonical": None,
        "body_text": None,
        "body_html": None,
        "images": [],
        "internal_links": [],
        "json_ld": [],
        "og_image": None,
        "lastmod": lastmod,
        "error": None,
    }

    try:
        resp = session.get(url, timeout=TIMEOUT)
        resp.raise_for_status()
    except Exception as e:
        data["error"] = str(e)
        return data

    soup = BeautifulSoup(resp.content, "html.parser")

    # Title
    title_tag = soup.find("title")
    if title_tag:
        data["title"] = title_tag.get_text(strip=True)

    # Meta description
    meta_desc = soup.find("meta", attrs={"name": "description"})
    if meta_desc:
        data["seo_description"] = meta_desc.get("content", "")

    # H1
    h1 = soup.find("h1")
    if h1:
        data["h1"] = h1.get_text(strip=True)

    # Canonical
    canon = soup.find("link", rel="canonical")
    if canon:
        data["canonical"] = canon.get("href", "")

    # OG image
    og_img = soup.find("meta", property="og:image")
    if og_img:
        data["og_image"] = og_img.get("content", "")

    # JSON-LD
    data["json_ld"] = extract_json_ld(soup)

    # Main content
    content_el = extract_main_content(soup)
    data["body_text"] = extract_body_text(content_el)
    data["body_html"] = str(content_el)
    data["images"] = extract_images(content_el, url)
    data["internal_links"] = extract_internal_links(content_el, url)

    return data


# ---------------------------------------------------------------------------
# Step 3 — build site structure
# ---------------------------------------------------------------------------

def build_site_structure(pages):
    """Build hierarchical site structure from scraped page data."""
    by_path = {p["path"]: p for p in pages}

    institutes = []
    static_pages = []
    teachers = []
    articles = []
    video_playlists = []

    institute_slugs = [
        "institut-klinicheskoy-prikladnoy-kineziologii",
        "institut-apledzhera",
        "institut-barralya",
    ]

    # Classify pages
    for page in pages:
        path = page["path"]
        depth = page["depth"]

        if "/prepodavatel/" in path:
            teachers.append({
                "path": path,
                "title": page.get("title") or page.get("h1") or "",
                "institute": "/" + path.split("/")[1] if len(path.split("/")) > 1 else None,
            })
        elif path.startswith("/video/pleylist/"):
            video_playlists.append({
                "path": path,
                "title": page.get("title") or page.get("h1") or "",
            })
        elif path.startswith("/statyi/") and depth >= 2:
            articles.append({
                "path": path,
                "title": page.get("title") or page.get("h1") or "",
            })

    # Build institute trees
    for slug in institute_slugs:
        inst_path = f"/{slug}"
        inst_page = by_path.get(inst_path)
        if not inst_page:
            continue

        inst_node = {
            "path": inst_path,
            "title": inst_page.get("title") or inst_page.get("h1") or "",
            "courses": [],
        }

        # Find depth-2 children (course groups)
        course_pages = [
            p for p in pages
            if p["path"].startswith(inst_path + "/")
            and p["depth"] == 2
            and "/prepodavatel/" not in p["path"]
        ]

        for cp in sorted(course_pages, key=lambda x: x["path"]):
            course_node = {
                "path": cp["path"],
                "title": cp.get("title") or cp.get("h1") or "",
                "seminars": [],
            }

            # Find depth-3 children (seminars)
            seminar_pages = [
                p for p in pages
                if p["path"].startswith(cp["path"] + "/")
                and p["depth"] == 3
                and "/prepodavatel/" not in p["path"]
            ]

            for sp in sorted(seminar_pages, key=lambda x: x["path"]):
                course_node["seminars"].append({
                    "path": sp["path"],
                    "title": sp.get("title") or sp.get("h1") or "",
                })

            inst_node["courses"].append(course_node)

        institutes.append(inst_node)

    # Static pages: depth 1, not institutes, not /statyi sub-pages
    static_slugs_exclude = set(institute_slugs)
    for page in pages:
        path = page["path"]
        depth = page["depth"]
        if depth <= 1 and path != "/":
            slug = path.lstrip("/")
            if slug not in static_slugs_exclude:
                static_pages.append({
                    "path": path,
                    "title": page.get("title") or page.get("h1") or "",
                })

    # Homepage
    homepage = by_path.get("/")
    if homepage:
        static_pages.insert(0, {
            "path": "/",
            "title": homepage.get("title") or homepage.get("h1") or "",
        })

    return {
        "institutes": institutes,
        "static_pages": sorted(static_pages, key=lambda x: x["path"]),
        "teachers": sorted(teachers, key=lambda x: x["path"]),
        "video_playlists": sorted(video_playlists, key=lambda x: x["path"]),
        "articles": sorted(articles, key=lambda x: x["path"]),
    }


# ---------------------------------------------------------------------------
# Step 4 — media inventory
# ---------------------------------------------------------------------------

def build_media_inventory(pages):
    """Build a deduplicated media inventory from all pages."""
    media_map = defaultdict(lambda: {"found_on": set(), "contexts": set()})

    for page in pages:
        path = page["path"]

        # Content images
        for img_url in page.get("images", []):
            media_map[img_url]["found_on"].add(path)
            media_map[img_url]["contexts"].add("content")

        # OG image
        if page.get("og_image"):
            media_map[page["og_image"]]["found_on"].add(path)
            media_map[page["og_image"]]["contexts"].add("og_image")

        # JSON-LD images
        for ld in page.get("json_ld", []):
            ld_str = json.dumps(ld)
            for match in re.findall(r'https?://[^\s"<>]+\.(?:jpg|jpeg|png|gif|webp|svg|avif)', ld_str, re.IGNORECASE):
                media_map[match]["found_on"].add(path)
                media_map[match]["contexts"].add("json_ld")

    inventory = []
    for url, info in sorted(media_map.items()):
        ext = url.rsplit(".", 1)[-1].lower().split("?")[0]
        media_type = "image" if ext in ("jpg", "jpeg", "png", "gif", "webp", "svg", "avif", "ico") else "other"
        # Pick primary context
        contexts = info["contexts"]
        if "content" in contexts:
            primary = "content"
        elif "og_image" in contexts:
            primary = "og_image"
        elif "json_ld" in contexts:
            primary = "json_ld"
        else:
            primary = "other"

        inventory.append({
            "url": url,
            "found_on": sorted(info["found_on"]),
            "type": media_type,
            "context": primary,
        })

    return inventory


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print("=" * 60)
    print("IKPK.SU FULL SITE SCRAPER")
    print("=" * 60)

    # Step 1: Sitemap
    print("\n[Step 1] Fetching sitemap...")
    sitemap_entries = fetch_sitemap()
    print(f"  Found {len(sitemap_entries)} URLs in sitemap")

    # Build lastmod lookup
    lastmod_map = {}
    for entry in sitemap_entries:
        path = get_path(entry["url"])
        lastmod_map[path] = entry.get("lastmod")

    # Step 2: Scrape all pages
    print(f"\n[Step 2] Scraping {len(sitemap_entries)} pages (with {DELAY}s delay)...")
    pages = []
    errors = []
    for i, entry in enumerate(sitemap_entries):
        url = entry["url"]
        lastmod = entry.get("lastmod")
        path = get_path(url)

        progress = f"[{i+1:3d}/{len(sitemap_entries)}]"
        sys.stdout.write(f"\r  {progress} {path[:60]:<60}")
        sys.stdout.flush()

        page_data = scrape_page(url, lastmod)
        pages.append(page_data)

        if page_data.get("error"):
            errors.append((url, page_data["error"]))

        if i < len(sitemap_entries) - 1:
            time.sleep(DELAY)

    print(f"\n  Done. Scraped {len(pages)} pages, {len(errors)} errors.")
    if errors:
        print("  Errors:")
        for url, err in errors:
            print(f"    - {url}: {err}")

    # Save content dump
    content_path = f"{OUTPUT_DIR}/content_dump.json"
    # Remove error field if None for cleanliness
    for p in pages:
        if p.get("error") is None:
            del p["error"]
    with open(content_path, "w", encoding="utf-8") as f:
        json.dump(pages, f, ensure_ascii=False, indent=2)
    print(f"\n  Saved {content_path}")

    # Step 3: Site structure
    print("\n[Step 3] Building site structure...")
    structure = build_site_structure(pages)
    structure_path = f"{OUTPUT_DIR}/site_structure.json"
    with open(structure_path, "w", encoding="utf-8") as f:
        json.dump(structure, f, ensure_ascii=False, indent=2)
    print(f"  Saved {structure_path}")

    # Step 4: Media inventory
    print("\n[Step 4] Building media inventory...")
    inventory = build_media_inventory(pages)
    inventory_path = f"{OUTPUT_DIR}/media_inventory.json"
    with open(inventory_path, "w", encoding="utf-8") as f:
        json.dump(inventory, f, ensure_ascii=False, indent=2)
    print(f"  Saved {inventory_path}")

    # Summary
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"  Total pages scraped:  {len(pages)}")
    print(f"  Pages with errors:    {len(errors)}")
    print(f"  Total images found:   {len(inventory)}")

    # Counts from structure
    total_seminars = sum(
        len(c["seminars"])
        for inst in structure["institutes"]
        for c in inst["courses"]
    )
    total_courses = sum(len(inst["courses"]) for inst in structure["institutes"])

    print(f"  Institutes:           {len(structure['institutes'])}")
    print(f"  Course groups:        {total_courses}")
    print(f"  Seminars:             {total_seminars}")
    print(f"  Teachers:             {len(structure['teachers'])}")
    print(f"  Articles:             {len(structure['articles'])}")
    print(f"  Video playlists:      {len(structure['video_playlists'])}")
    print(f"  Static pages:         {len(structure['static_pages'])}")

    # Depth distribution
    depth_dist = defaultdict(int)
    for p in pages:
        depth_dist[p["depth"]] += 1
    print(f"\n  Depth distribution:")
    for d in sorted(depth_dist):
        print(f"    depth {d}: {depth_dist[d]} pages")

    print("\n  Done! All files saved to discovery/")


if __name__ == "__main__":
    main()
