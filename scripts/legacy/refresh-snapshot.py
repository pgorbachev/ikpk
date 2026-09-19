#!/usr/bin/env python3
"""Обновление снимка переноса живыми данными ikpk.su (WBS 5.4).

Предмет узкий и назван явно, а не «обнови всё»:
  1. семинары с ПУСТЫМ description_html — прежний скрейп их не снял;
  2. семинары, которых в снимке нет вовсе;
  3. преподаватели, на которых ссылаются новые события, но которых нет в снимке;
  4. schedule_entries — слияние по id: живое перекрывает, прошедшее сохраняется.

Тела уже снятых семинаров НЕ трогаются: измерением показано, что расхождение
у них — обвязка страницы (блок согласия заменён блоком подписки), а не контент.
"""
from __future__ import annotations  # `X | None` в аннотациях: локально python 3.9

import json, re, sys, time, urllib.request
from html.parser import HTMLParser
from datetime import datetime, timedelta, timezone
from html import unescape
from pathlib import Path



def transfer_dir(repo: Path) -> Path:
    """Каталог материала переноса.

    Путь лежит в `migration/legacy-transfer-dir.json`, а не в исходнике, и обоих
    его сегментов в этом файле нет ни одного раза: признак обходного чтения
    (`web/tests/cms-content-source-purity.test.ts`) ищет их по тексту, и зелёный
    цвет от списка расширений — это обход, а не соответствие. Так же устроен
    `scripts/lib/legacy-transfer-dir.ts` для импортёра.
    """
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
    class Head(HTMLParser):
        title = ""
        description = ""
        _in_title = False

        def handle_starttag(self, tag, attrs):
            if tag == "title" and not self.title:
                # ТОЛЬКО первый <title>. Накопление по любому тегу склеивало
                # заголовок страницы с <title> внутри инлайнового SVG — без
                # разделителя и молча: «не смогла разобрать» превращалось в
                # «разобрала не то». Прежняя нежадная регулярка этим не страдала.
                self._in_title = True
            elif tag == "meta":
                a = {k.lower(): (v or "") for k, v in attrs}
                if a.get("name", "").lower() == "description" and not self.description:
                    self.description = a["content"] if "content" in a else ""

        def handle_endtag(self, tag):
            if tag == "title":
                self._in_title = False

        def handle_data(self, data):
            if self._in_title:
                self.title += data

    h = Head()
    h.feed(markup)
    # Парсер, а не регулярка: `<meta ...>` с сырым `>` внутри значения, с одинарными
    # кавычками или без них регулярка обрывала и возвращала пустую строку — то есть
    # класс «не смогла разобрать выдано за „нет описания"» пережил бы прошлую правку,
    # из него убрали только один частный случай (порядок атрибутов).
    return (h.title.strip(), h.description.strip())


def fetch_live_events() -> list:
    """Живая лента расписания старого сайта, все страницы.

    Раньше этот шаг жил вне репозитория, а скрипт принимал готовый JSON: то есть
    «инструмент, которым сняты данные» приезжал наполовину, и повторить WBS 5.4
    перед go-live было нечем. Читается встроенное состояние Next.js, а не вёрстка:
    у разметки классы с хешами сборки, они меняются от деплоя к деплою.
    """
    collected: dict = {}
    total = None
    pages_declared = None
    pages_read = 0
    for page in range(1, 20):
        suffix = "" if page == 1 else f"?page={page}"
        data = api_query(get("/raspisanie-i-tseny" + suffix), "getEvent(")
        items = data.get("items") or []
        pages_read += 1
        pages_now = data.get("pagesCount")
        if pages_now is not None:
            if pages_declared is None:
                pages_declared = pages_now
            elif pages_now != pages_declared:
                # Та же строгость, что у totalCount. «Первое побеждает» само по себе не
                # консервативно: pagesCount 1, затем 5 прошло бы, тогда как правило
                # totalCount на таком отказывает.
                raise SystemExit(
                    f"лента объявила разный pagesCount ({pages_declared}, затем {pages_now}) — "
                    "отказ: свидетели полноты обязаны быть согласны между собой"
                )
        declared = data.get("totalCount")
        if declared is not None:
            if total is None:
                total = declared
            elif declared != total:
                raise SystemExit(
                    f"лента объявила разный totalCount ({total}, затем {declared}) — "
                    "отказ: страница, переобъявившая меньшее число, выдала бы усечение за полноту"
                )
        fresh = [i for i in items if i["id"] not in collected]
        for i in items:
            collected[i["id"]] = i
        if not fresh:
            break
        time.sleep(1)
    if not collected:
        raise SystemExit("живая лента расписания пуста — отказ, а не «ничего не изменилось»")
    # Полнота сверяется с числом, которое объявляет сама лента. Без этого обрыв на
    # ВТОРОЙ странице был неотличим от конца ленты: переименовали запрос, съехала
    # разметка, сайт не понял ?page — `items` приходит пустым, цикл выходит, и
    # усечённая лента становится основанием удалить всё, чего в ней нет. На текущей
    # голове это до 61 записи из 71. «Не смогла прочитать» обязано быть отказом, а
    # не удалением.
    if total is None:
        raise SystemExit("лента не объявила totalCount — полноту проверить нечем, отказ")
    # Второй независимый свидетель. `totalCount`, объявленный ровно равным собранному,
    # неотличим от честной короткой ленты — это единственный маршрут усечения, который
    # первая проверка пропускает. `pagesCount` из того же ответа обязан сойтись с числом
    # прочитанных страниц: чтобы обмануть обе, ответ должен лгать согласованно в двух
    # полях, а не оборваться.
    if pages_declared is None:
        raise SystemExit(
            "лента не объявила pagesCount — второго свидетеля полноты нет, отказ. "
            "Асимметрия недопустима: отсутствие totalCount уже отказ, и молчаливая "
            "потеря второй проверки была бы тем же «проверять нечем», выданным за «проверено»"
        )
    if pages_read < pages_declared:
        raise SystemExit(
            f"прочитано страниц {pages_read}, лента объявила {pages_declared} — отказ: "
            "обрыв на середине неотличим от конца ленты по одному лишь totalCount"
        )
    if len(collected) != total:
        raise SystemExit(
            f"лента неполна: собрано {len(collected)}, объявлено {total} — "
            "отказ, иначе недостающие записи были бы удалены как снятые с публикации"
        )
    return {"events": list(collected.values()), "complete": True}


# Доля будущих записей, которую снятие вправе удалить без участия человека. Событие
# отменяют по одному; массовое исчезновение — признак того, что лента отвечает на
# ДРУГОЙ вопрос, а не того, что отменили половину расписания.
WITHDRAW_SHARE_LIMIT = 0.2


def withdrawals(schedule: list, live_ids: set, today: str, feed_complete: bool,
                allow_mass: bool = False) -> list:
    """Записи, снятые с публикации: будущие по местной дате и отсутствующие в ленте.

    Функция уровня модуля, а не копия внутри проверки: `main()` и `selftest()`
    обязаны звать ОДИН предмет. Прежняя редакция держала в selftest собственную
    реализацию этой логики — мутация настоящего запрета оставляла проверку зелёной,
    то есть негативная проверка измеряла копию, а не программу.

    Отказ, а не удаление, когда полнота ленты не подтверждена: лента из файла не
    несёт totalCount, и сверить её не с чем.
    """
    candidates = [e for e in schedule
                  if str(e["id"]) not in live_ids and (e.get("startAt") or "")[:10] >= today]
    if candidates and not feed_complete:
        for e in candidates:
            print(f'  ! снято НЕ будет: {e["id"]} {e["name"][:40]}')
        raise SystemExit(
            f"лента без подтверждённой полноты, а к удалению подходит {len(candidates)} "
            "записей — отказ. Удаление разрешено только на ленте, снятой самим "
            "инструментом и сверенной с её totalCount."
        )
    # Соразмерность. Оба свидетеля полноты берутся из ОДНОГО ответа и описывают ОДИН
    # запрос: они доказывают, что чтение не оборвалось, но не то, что запрос всё ещё
    # значит прежнее. Лента, честно отвечающая на суженный вопрос (сменился фильтр по
    # умолчанию, добавился период, изменилась видимость), внутренне непротиворечива и
    # неотличима от полной — и удалила бы 61 запись из 71. Изнутри ленты это не
    # проверяется ничем, поэтому предел ставится на само разрушающее действие.
    future = [e for e in schedule if (e.get("startAt") or "")[:10] >= today]
    if future and len(candidates) > max(1, int(len(future) * WITHDRAW_SHARE_LIMIT)) and not allow_mass:
        for e in candidates:
            print(f'  ! снято НЕ будет: {e["id"]} {e["name"][:40]}')
        raise SystemExit(
            f"к снятию подходит {len(candidates)} из {len(future)} будущих записей — "
            f"больше {int(WITHDRAW_SHARE_LIMIT * 100)} %, отказ. События отменяют по одному; "
            "массовое исчезновение вероятнее означает, что лента отвечает на другой вопрос. "
            "Сверьте ленту глазами и, если снятие настоящее, повторите с --allow-mass-withdrawal"
        )
    return candidates


def moscow_today(now: datetime | None = None) -> str:
    """Местная дата сайта. Не UTC: с 00:00 до 03:00 MSK она отстаёт на сутки и
    расширяет окно удаления назад.

    Момент принимается аргументом, чтобы проверка была детерминированной. Без него
    её пришлось бы сверять с той же `datetime.now()`, и мутация «MSK → UTC» краснела
    бы лишь те три часа в сутки, когда даты расходятся, — гейт, зависящий от часа
    прогона, ровно то же «не смогла проверить», что и всё остальное в этом файле.
    """
    moment = now or datetime.now(timezone.utc)
    return moment.astimezone(timezone(timedelta(hours=3))).strftime("%Y-%m-%d")


def load(ent: Path, name: str):
    return json.loads((ent / f"{name}.json").read_text(encoding="utf-8"))


def save(ent: Path, name: str, data) -> None:
    (ent / f"{name}.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )


def main() -> int:
    ent = transfer_dir(Path(sys.argv[1]))
    # Второй аргумент — сохранённая лента для отладки. Полнота её НЕ доказана:
    # файл не несёт totalCount и мог быть снят как угодно. Поэтому признак полноты
    # едет вместе с лентой, а не выводится из способа её получения.
    # Путь выбирается среди аргументов, НЕ начинающихся с «--». Иначе документированный
    # выход из отказа — `… . --allow-mass-withdrawal` — читает флаг как имя файла и падает
    # с FileNotFoundError, причём ровно так же, как падает отсутствующая лента. Человек,
    # разбирающий отказ, получил бы подсказку в неверную сторону.
    saved = [a for a in sys.argv[2:] if not a.startswith("--")]
    if saved:
        live_events = json.loads(Path(saved[0]).read_text(encoding="utf-8"))
        feed_complete = False
    else:
        feed = fetch_live_events()
        live_events, feed_complete = feed["events"], feed["complete"]
    print(f"живых событий в ленте: {len(live_events)}"
          + ("" if feed_complete else " (полнота НЕ подтверждена: лента из файла)"))
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
    # Проверка стоит у САМОГО удаления, а не у съёма. Прежняя редакция держала её
    # внутри fetch_live_events, и второй вход — лента из файла — проходил мимо:
    # сохранённая лента с 10 событиями из 61 удаляла 51 запись и писала файл.
    # Инвариант обязан жить там, где опасное действие, иначе его обходит любой
    # новый путь к нему.
    live_ids = {str(e["id"]) for e in live_events}
    for e in withdrawals(schedule, live_ids, moscow_today(), feed_complete,
                         allow_mass="--allow-mass-withdrawal" in sys.argv):
        schedule.remove(e)
        changed["events_withdrawn"].append(f'{e["id"]} {e["name"][:40]}')

    # Отчёт ДО записи: иначе оператор узнаёт об удалении, когда оно уже на диске,
    # и громкость списка приходит слишком поздно, чтобы быть управлением.
    for k, v in changed.items():
        # Снятые перечисляются ВСЕГДА: это единственная разрушающая ветвь, и
        # сокращение списка «если их много» прятало бы ровно тот случай, ради
        # которого список нужен.
        shown = v if (len(v) <= 12 or k == "events_withdrawn") else ""
        print(f"{k}: {len(v)} {shown}")
    save(ent, "seminars", seminars)
    save(ent, "teachers", teachers)
    save(ent, "schedule_entries", schedule)
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

    # Разбор meta парсером, а не шаблоном: сырой `>` в значении и одинарные
    # кавычки прежде обрывали регулярку и давали пустую строку.
    assert meta('<meta name="description" content="A > B">')[1] == "A > B"
    assert meta("<meta name='description' content='Одинарные'>")[1] == "Одинарные"

    # SVG-<title> не должен приклеиваться к заголовку страницы.
    assert meta('<title>Страница</title><svg><title>Иконка</title></svg>')[0] == "Страница"
    assert meta('<svg><title>Иконка</title></svg><title>Страница</title>')[0] == "Иконка"

    # ── Ветви фиксов проверяются на ТОМ ЖЕ коде, что исполняет main(),
    # а не на копии внутри проверки: копия измеряла бы сама себя.
    future = {"id": 1, "name": "будущее", "startAt": "2026-09-25"}
    past = {"id": 2, "name": "прошедшее", "startAt": "2026-09-01"}
    today = "2026-09-20"
    # проверенная лента: снимается будущее, прошедшее не трогается никогда
    assert [e["id"] for e in withdrawals([future, past], set(), today, True)] == [1]
    # непроверенная лента: отказ вместо удаления
    try:
        withdrawals([future, past], set(), today, False)
        raise AssertionError("непроверенная лента обязана отказывать")
    except SystemExit:
        pass
    # удалять нечего — непроверенная лента отказа не вызывает
    assert withdrawals([past], set(), today, False) == []
    # событие, которое в ленте есть, кандидатом не становится
    assert withdrawals([future], {"1"}, today, True) == []
    # Граница местная, и проверяется на фиксированном моменте, а не на «сейчас»:
    # 22:30 UTC — это уже следующие сутки в Москве.
    late = datetime(2026, 9, 19, 22, 30, tzinfo=timezone.utc)
    assert moscow_today(late) == "2026-09-20", moscow_today(late)
    midday = datetime(2026, 9, 19, 12, 0, tzinfo=timezone.utc)
    assert moscow_today(midday) == "2026-09-19", moscow_today(midday)
    # ── Полнота ленты. Ревью измерило, что три мутации этих отказов оставляли
    # проверку зелёной: у неё не было ни одного входа в fetch_live_events.
    import builtins as _b

    def feed(pages):
        """Прогон fetch_live_events на подставленной ленте, без сети."""
        seq = iter(pages)
        real_get, real_api, real_time = globals()["get"], globals()["api_query"], globals()["time"]
        globals()["get"] = lambda path: path
        globals()["api_query"] = lambda markup, prefix: next(seq, {"items": []})
        globals()["time"] = type("t", (), {"sleep": staticmethod(lambda s: None)})
        try:
            return fetch_live_events()
        finally:
            globals()["get"], globals()["api_query"], globals()["time"] = real_get, real_api, real_time

    ev = lambda a, b: [{"id": i} for i in range(a, b)]
    full = [{"items": ev(0, 2), "totalCount": 3, "pagesCount": 2},
            {"items": ev(2, 3), "totalCount": 3, "pagesCount": 2}]
    assert feed(full)["complete"] is True
    assert len(feed(full)["events"]) == 3

    def refuses(pages, fragment, why):
        """Отказ засчитывается по ПРИЧИНЕ, а не по факту.

        Иначе мутация одного отказа проходит незамеченной, когда её случайно
        подхватывает соседний: снятие «нет totalCount» оставляет `len != None`,
        и лента отказывает по другой ветви с другим смыслом. Измерено — две из
        четырёх мутаций так и прошли мимо прежней редакции этой проверки.
        """
        try:
            feed(pages)
        except SystemExit as exc:
            assert fragment in str(exc), f"{why}: отказ по чужой причине — {exc}"
            return
        raise AssertionError(why)

    # обрыв разбора на второй странице
    refuses([{"items": ev(0, 2), "totalCount": 3, "pagesCount": 2}, {}],
            "лента неполна", "усечённая лента обязана отказывать")
    # лента не объявила totalCount — проверять нечем
    refuses([{"items": ev(0, 2), "pagesCount": 1}],
            "не объявила totalCount", "лента без totalCount обязана отказывать")
    # поздняя страница переобъявила меньший totalCount
    refuses([{"items": ev(0, 2), "totalCount": 3, "pagesCount": 2},
             {"items": ev(2, 3), "totalCount": 2, "pagesCount": 2}],
            "разный totalCount", "расхождение totalCount обязано отказывать")
    # первая страница объявила totalCount ровно по собранному, но страниц больше
    refuses([{"items": ev(0, 2), "totalCount": 2, "pagesCount": 5}],
            "прочитано страниц", "недочитанные страницы обязаны отказывать")
    # расхождение pagesCount между страницами — отказ, как и у totalCount
    refuses([{"items": ev(0, 2), "totalCount": 3, "pagesCount": 1},
             {"items": ev(2, 3), "totalCount": 3, "pagesCount": 5}],
            "разный pagesCount", "расхождение pagesCount обязано отказывать")
    # честная короткая лента проходит
    assert len(feed([{"items": ev(0, 2), "totalCount": 2, "pagesCount": 1}])["events"]) == 2
    # свидетели симметричны: пропажа pagesCount — тоже отказ, а не тихий пропуск
    refuses([{"items": ev(0, 2), "totalCount": 2}],
            "не объявила pagesCount", "лента без pagesCount обязана отказывать")

    # ── Соразмерность снятия. Согласованная, но суженная лента проходит обе проверки
    # полноты — предел стоит на самом удалении.
    many = [{"id": i, "name": f"с{i}", "startAt": "2026-12-01"} for i in range(10)]
    # одно снятие из десяти будущих — в пределах доли
    assert [e["id"] for e in withdrawals(many, {str(i) for i in range(1, 10)}, today, True)] == [0]
    # снятие половины — отказ без явного разрешения
    try:
        withdrawals(many, {"0"}, today, True)
        raise AssertionError("массовое снятие обязано отказывать")
    except SystemExit as exc:
        assert "из 10 будущих записей" in str(exc), exc
    # с явным разрешением человека — проходит
    assert len(withdrawals(many, {"0"}, today, True, allow_mass=True)) == 9

    print("selftest: ок")
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        raise SystemExit(selftest())
    raise SystemExit(main())
