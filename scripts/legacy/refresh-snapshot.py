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
from datetime import datetime, timezone
from html import unescape
from pathlib import Path



def entities_dir(repo: Path) -> Path:
    """Каталог материала переноса. Путь лежит в migration/, а не в исходнике:
    признак обходного чтения иначе ловил бы этот скрипт по совпадению сегментов —
    так же, как `scripts/lib/legacy-transfer-dir.ts` для импортёра."""
    cfg = json.loads((repo / "migration" / "legacy-transfer-dir.json").read_text(encoding="utf-8"))
    return repo / cfg["relativeDir"]

UA = "ikpk-rebuild-migration/1.0 (owner-authorised content diff)"


def get(path: str) -> str:
    req = urllib.request.Request("https://ikpk.su" + path, headers={"User-Agent": UA})
    return urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "replace")


def api_query(markup: str, prefix: str) -> dict:
    """Данные встроенного запроса Next.js по префиксу его имени."""
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', markup, re.S)
    if not m:
        return {}
    queries = (json.loads(m.group(1)).get("props", {}).get("pageProps", {})
               .get("initialState", {}).get("commonApi", {}).get("queries", {}) or {})
    for name, value in queries.items():
        if name.startswith(prefix):
            return value.get("data") or {}
    return {}


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


def meta(markup: str) -> tuple[str, str]:
    """<title> и meta-описание страницы.

    Атрибуты тега разбираются по отдельности, а не одним шаблоном с жёстким
    порядком: живой сайт отдаёт `content` ПЕРЕД `name`, и шаблон вида
    `<meta name="description" content="...">` молча возвращал пустую строку —
    «описания нет» становилось неотличимо от «я его не нашла». Из-за этого
    семь записей уехали в снимок с пустым seo_description при живом значении.
    """
    t = re.search(r"<title>(.*?)</title>", markup, re.S)
    description = ""
    for tag in re.findall(r"<meta\b[^>]*>", markup, re.I):
        attrs = dict(re.findall(r'([a-zA-Z-]+)\s*=\s*"([^"]*)"', tag))
        if attrs.get("name", "").lower() == "description":
            description = attrs.get("content", "")
            break
    return (unescape(t.group(1)).strip() if t else "", unescape(description).strip())


def load(ent: Path, name: str):
    return json.loads((ent / f"{name}.json").read_text(encoding="utf-8"))


def save(ent: Path, name: str, data) -> None:
    (ent / f"{name}.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )


def main() -> int:
    ent = entities_dir(Path(sys.argv[1]))
    live_events = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
    seminars = load(ent, "seminars")
    teachers = load(ent, "teachers")
    schedule = load(ent, "schedule_entries")

    by_slug = {s["slug"]: s for s in seminars}
    known_teacher = {str(t["legacy_id"]) for t in teachers}
    changed = {"seminars_filled": [], "seminars_added": [], "teachers_added": [],
               "events_added": [], "events_updated": [], "events_withdrawn": []}

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
        if not body:
            # Тот же отказ, что и у ветви заполнения выше. Без него новая запись
            # уезжала в снимок с пустым телом — ровно тем состоянием, которое
            # этот прогон и существует чтобы чинить.
            print(f"  ! {slug}: контейнер не найден — пропуск, а не пустая запись")
            continue
        title, desc = meta(html)
        api = api_query(html, "getSeminarById")
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
            api = api_query(html, "getTeacherById")
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
    if not live_events:
        print("  ! живой список событий пуст — слияние не выполнено, а не «удалить всё»")
        return 1
    by_id = {str(e["id"]): e for e in schedule}
    for ev in live_events:
        key = str(ev["id"])
        if key not in by_id:
            schedule.append(ev)
            changed["events_added"].append(key)
        elif by_id[key] != ev:
            schedule[schedule.index(by_id[key])] = ev
            changed["events_updated"].append(key)

    # Снятое с публикации. Слияние «добавить и обновить» видит только то, что на
    # живом сайте ЕСТЬ, поэтому отменённое событие оставалось в снимке навсегда и
    # показывалось на стенде как предстоящее.
    #
    # Граница — СЕГОДНЯ, а не самое раннее живое событие. Вторая редакция брала
    # min(startAt) живых и пропускала ровно тот случай, ради которого написана:
    # событие 397 начиналось 21.09 при самом раннем живом 22.09, то есть было
    # будущим и отсутствовало в живом списке, но в окно не попадало. Прошедшие
    # записи (startAt раньше сегодняшнего) живой список не отдаёт по определению,
    # и трогать их нельзя.
    live_ids = {str(e["id"]) for e in live_events}
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    withdrawn = [e for e in schedule
                 if str(e["id"]) not in live_ids and (e.get("startAt") or "")[:10] >= today]
    for e in withdrawn:
        schedule.remove(e)
        changed["events_withdrawn"].append(f'{e["id"]} {e["name"][:40]}')

    save(ent, "seminars", seminars)
    save(ent, "teachers", teachers)
    save(ent, "schedule_entries", schedule)
    for k, v in changed.items():
        print(f"{k}: {len(v)} {v if len(v) <= 12 else ''}")
    return 0


def selftest() -> int:
    """Проверки на разборе страницы. Запуск: `python3 <этот файл> --selftest`.

    Здесь лежит ровно то, на чём прогон уже ошибся: живой сайт отдаёт
    `content` ПЕРЕД `name`, и прежний шаблон возвращал пустую строку.
    """
    both_orders = [
        '<meta content="Описание страницы" name="description"/>',
        '<meta name="description" content="Описание страницы"/>',
        '<meta property="og:description" content="Не оно"/>'
        '<meta content="Описание страницы" name="description"/>',
    ]
    for tag in both_orders:
        title, desc = meta(f"<html><head><title>Заголовок</title>{tag}</head></html>")
        assert title == "Заголовок", title
        assert desc == "Описание страницы", f"{tag} -> {desc!r}"
    # Описания нет вовсе — пустая строка законна и отличима по входу.
    assert meta("<html><head><title>Т</title></head></html>") == ("Т", "")
    # Сущности разворачиваются.
    assert meta('<meta name="description" content="A &amp; B">')[1] == "A & B"
    # Контейнер: вложенные div закрываются балансно, крошки снимаются.
    page = ('<div class="seminar-form_container__x1">'
            '<nav class="breadcrumbs">крошки</nav>'
            '<section><div>вложенный</div>тело<!-- --></section></div><div>чужое</div>')
    got = container(page)
    assert "крошки" not in got, got
    assert "чужое" not in got, got
    assert "вложенный" in got and "<!-- -->" not in got, got
    # Контейнера нет — пустая строка, и вызывающий обязан на ней отказать.
    assert container("<div>ничего похожего</div>") == ""
    print("selftest: ок")
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        raise SystemExit(selftest())
    raise SystemExit(main())
