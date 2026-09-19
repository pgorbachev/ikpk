#!/usr/bin/env python3
"""Обновление discovery-снимка живыми данными ikpk.su (WBS 5.4).

Предмет узкий и назван явно, а не «обнови всё»:
  1. семинары с ПУСТЫМ description_html — прежний скрейп их не снял;
  2. семинары, которых в снимке нет вовсе;
  3. преподаватели, на которых ссылаются новые события, но которых нет в снимке;
  4. schedule_entries — слияние по id: живое перекрывает, прошедшее сохраняется.

Тела уже снятых семинаров НЕ трогаются: измерением показано, что расхождение
у них — обвязка страницы (блок согласия заменён блоком подписки), а не контент.
"""
import json, re, sys, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve()
REPO = Path(sys.argv[1])
ENT = REPO / "discovery" / "entities"
UA = "ikpk-rebuild-migration/1.0 (owner-authorised content diff)"


def get(path: str) -> str:
    req = urllib.request.Request("https://ikpk.su" + path, headers={"User-Agent": UA})
    return urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "replace")


def next_data(html: str) -> dict:
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    return json.loads(m.group(1)) if m else {}


def container(html: str) -> str:
    """Тело страницы семинара так, как его снимал прежний скрейп.

    Правило выведено сверкой с уже снятой записью: контейнер seminar-form,
    без служебных <!-- --> Next.js и без хлебных крошек.
    """
    i = html.find('<div class="seminar-form_container__')
    if i < 0:
        return ""
    depth = 0
    j = -1
    for m in re.finditer(r"<div\b|</div>", html[i:]):
        depth += 1 if m.group(0) != "</div>" else -1
        if depth == 0:
            j = i + m.end()
            break
    if j < 0:
        return ""
    body = html[i:j].replace("<!-- -->", "")
    return re.sub(r"<nav\b.*?</nav>", "", body, count=1, flags=re.S)


def to_text(markup: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", markup)).strip()


def meta(html: str) -> tuple[str, str]:
    t = re.search(r"<title>(.*?)</title>", html, re.S)
    d = re.search(r'<meta name="description" content="(.*?)"', html, re.S)
    import html as H

    return (H.unescape(t.group(1)).strip() if t else "",
            H.unescape(d.group(1)).strip() if d else "")


def load(name: str):
    return json.loads((ENT / f"{name}.json").read_text(encoding="utf-8"))


def save(name: str, data) -> None:
    (ENT / f"{name}.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )


def main() -> int:
    live_events = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
    seminars = load("seminars")
    teachers = load("teachers")
    schedule = load("schedule_entries")

    by_slug = {s["slug"]: s for s in seminars}
    known_teacher = {str(t["legacy_id"]) for t in teachers}
    changed = {"seminars_filled": [], "seminars_added": [], "teachers_added": [],
               "events_added": [], "events_updated": []}

    # ── 1. семинары с пустым телом ────────────────────────────────────────────
    for s in [x for x in seminars if not (x.get("description_html") or "").strip()]:
        html = get(s["legacy_url"])
        body = container(html)
        if not body:
            print(f"  ! {s['slug']}: контейнер не найден — пропуск, а не пустая запись")
            continue
        title, desc = meta(html)
        s["description_html"] = body
        s["description_text"] = to_text(body)
        if not s.get("seo_title"):
            s["seo_title"] = title
        if not s.get("seo_description"):
            s["seo_description"] = desc
        changed["seminars_filled"].append(s["slug"])
        time.sleep(0.8)

    # ── 2. новые семинары из живых событий ───────────────────────────────────
    inst_path = {1: "institut-klinicheskoy-prikladnoy-kineziologii",
                 2: "institut-apledzhera", 3: "institut-barralya"}
    for ev in live_events:
        sem = ev.get("seminar") or {}
        slug = sem.get("slug")
        if not slug or slug in by_slug:
            continue
        inst = inst_path.get((ev.get("institute") or {}).get("id"))
        prog = (ev.get("program") or {}).get("slug")
        if not inst or not prog:
            print(f"  ! {slug}: не удалось определить путь — пропуск")
            continue
        url = f"/{inst}/{prog}/{slug}"
        html = get(url)
        body = container(html)
        title, desc = meta(html)
        nd = next_data(html)
        api = {}
        for k, v in (nd.get("props", {}).get("pageProps", {}).get("initialState", {})
                     .get("commonApi", {}).get("queries", {}) or {}).items():
            if k.startswith("getSeminarById"):
                api = v.get("data") or {}
        rec = {
            "legacy_id": url.lstrip("/"),
            "legacy_url": url,
            "name": sem.get("name") or api.get("name") or "",
            "slug": slug,
            "course_group_legacy_id": f"{inst}/{prog}",
            "seo_title": title,
            "seo_description": desc,
            "description_html": body,
            "description_text": to_text(body),
            "images": [],
            "status": "planned",
            "order": api.get("priority") or 1,
            "institute_legacy_id": inst,
            "teachers": [
                {"legacy_id": t["id"], "name": t.get("fullName", ""),
                 "order": t.get("priority") or 1}
                for t in (api.get("teachers") or [])
            ],
        }
        seminars.append(rec)
        by_slug[slug] = rec
        changed["seminars_added"].append(slug)
        time.sleep(0.8)

    # ── 3. преподаватели, на которых ссылаются новые события ─────────────────
    for ev in live_events:
        for t in ev.get("teachers") or []:
            tid = str(t["id"])
            if tid in known_teacher:
                continue
            inst = inst_path.get((ev.get("institute") or {}).get("id"),
                                 "institut-klinicheskoy-prikladnoy-kineziologii")
            url = f"/{inst}/prepodavatel/{tid}"
            html = get(url)
            nd = next_data(html)
            api = {}
            for k, v in (nd.get("props", {}).get("pageProps", {}).get("initialState", {})
                         .get("commonApi", {}).get("queries", {}) or {}).items():
                if k.startswith("getTeacherById"):
                    api = v.get("data") or {}
            bio = api.get("description") or ""
            teachers.append({
                "legacy_id": int(tid),
                "legacy_url": f"/teachers/{tid}",
                "name": api.get("fullName") or t.get("fullName", ""),
                "slug": tid,
                "institute_legacy_id": inst,
                "bio_html": bio,
                "bio_text": to_text(bio),
                "photo": (api.get("image") or {}).get("url", ""),
                "order": api.get("priority") or 1,
            })
            known_teacher.add(tid)
            changed["teachers_added"].append(tid)
            time.sleep(0.8)

    # ── 4. расписание: слияние по id ─────────────────────────────────────────
    by_id = {str(e["id"]): e for e in schedule}
    for ev in live_events:
        key = str(ev["id"])
        if key not in by_id:
            schedule.append(ev)
            changed["events_added"].append(key)
        elif by_id[key] != ev:
            schedule[schedule.index(by_id[key])] = ev
            changed["events_updated"].append(key)

    save("seminars", seminars)
    save("teachers", teachers)
    save("schedule_entries", schedule)
    for k, v in changed.items():
        print(f"{k}: {len(v)} {v if len(v) <= 12 else ''}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
