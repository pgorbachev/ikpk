# -*- coding: utf-8 -*-
"""
Матрица ветвления POST /payments по совпадениям и статусам записи.

ЧТО ЭТА ПРОВЕРКА ДОКАЗЫВАЕТ И ЧЕГО НЕ ДОКАЗЫВАЕТ — читать до чисел:

  * доказывает: транскрипция правил ниже **полна** (каждая комбинация входов получает
    ровно один исход) и **детерминирована**; инварианты — регрессионные проверки самой
    транскрипции: они краснеют, если её потом отредактируют неверно;
  * НЕ доказывает: что транскрипция соответствует нормативному тексту. Это проверяется
    только чтением спеки человеком/ревьюером. Инварианты по построению переформулируют
    строки диспетчера, то есть независимым свидетельством о правилах change не являются.

Область: ветвление по найденной записи, совпадению отпечатка и статусам. Валидация
формата и суммы (400/422), лимит частоты (429), сбой создания (5xx) и демонстрационный
исход (created_demo / GET demo) сюда НЕ входят — они лежат до этого ветвления и разобраны
отдельными требованиями.

НЕ ВХОДИТ В ОСИ (названо, чтобы полнота не читалась шире предмета):

  * пометка verificationAt / verificationReason — исход POST от пометки не зависит;
    шаг 5 отвечает verification_required без пометки, шаги 1а/6 помечают при условиях;
  * у совпавшей по отпечатку записи (шаг 1а) нет оси «есть ли yookassaPaymentId»:
    исход всегда VERIF при живом незавершённом совпадении, меняется только запись/журнал;
  * TTL confirmation-токена (15 минут) — ось valid_token уже покрывает «действителен /
    недействителен»; истечение — частный случай недействительности, проверяется задачей
    3.10a-3b(11), не этой матрицей.

Версия 8 (ревью r9 / m2): истёкшая незавершённая + подтверждённая с неизвестной версией
ключа даёт CREATE, не VERIF и не DUP. Невидимая подтверждённая поиск не занимает.

Версия 7 (ревью r8 / B1): истёкшая незавершённая не отменяет поиск среди подтверждённых.
Приоритет незавершённой — только у живой блокировки; старше 14 суток от создания —
совпадения нет, дальше подтверждённые младше 14 суток от подтверждения.

Версия 6 (ревью r7 / B2): видимость ключа незавершённой и подтверждённой записей —
раздельные оси. Незавершённая с неизвестной версией невидима и не отменяет поиск среди
подтверждённых: комбинация «незавершённая невидима + подтверждённая младше 14 суток с
известным ключом» представима и даёт DUP.

Версия 5 (ревью r6 / reconciliation): fp_match больше не взаимоисключающий. Незавершённое
и подтверждённое совпадение одного состава выразимы одновременно; незавершённое имеет
приоритет (исход VERIF). Якорь 14 суток для подтверждённой записи — от момента
подтверждения платежа, не от создания записи.

Версия 4 (BLOCKER-A ревью r5-adv): поиск среди подтверждённых записей тоже читает версию
ключа — запись неизвестной версии для него невидима.

Версия 3: исправлены три дефекта версии 2, найденные ревью r5 (MAJOR-7).
"""
from itertools import product

CREATE, ALREADY, CANCELED = "create_payment", "already_paid", "canceled"
CONFLICT_409, VERIF, DUP = "409_content_changed", "verification_required", "duplicate_confirmation_required"
EXISTING, RETRY = "return_existing_state", "retry_to_psp_same_key"


def dispatch(c):
    """Буквальная запись «Итогового порядка» (Решение 2а) с шагом 1а (Решения 2е/2к)."""
    if c["found_by_request_id"]:
        st = c["status"]
        if st == "succeeded":
            return ALREADY, "3"                                   # отпечаток и версия не проверяются
        if st == "canceled":
            if not c["key_known"]:
                return CANCELED, "4-unknown-key"
            return (CANCELED, "4-match") if c["content_match"] else (CONFLICT_409, "4-mismatch")
        if not c["key_known"]:
            return VERIF, "6"
        if not c["content_match"]:
            return VERIF, "5-mismatch"
        if c["has_payment_id"]:
            return EXISTING, "5-existing"
        return (RETRY, "5-continue") if c["within_dedup"] else (VERIF, "5-beyond-window")

    # шаг 1а: сначала живые незавершённые совпадения, затем подтверждённые (блокер 3 / r8 B1)
    # fp_nonterminal и fp_confirmed_lt14d независимы: одно содержимое может совпасть с обеими.
    # Видимость ключа двух поисков тоже независима (r7 B2): неизвестная версия незавершённой
    # не делает невидимой подтверждённую. Истёкшая незавершённая живой не является (r8 B1)
    # и поиск среди подтверждённых не отменяет.
    if c["fp_nonterminal"] and c["nt_key_known"] and c["m_age_lt14d"]:
        return VERIF, "1a-nonterminal-match"                      # приоритет только у живой блокировки
    # истёкшая незавершённая — не совпадение; дальше поиск подтверждённых
    if c["fp_confirmed_lt14d"]:
        if not c["cf_key_known"]:
            return CREATE, "1a-dup-unknown-ver"
        return (CREATE, "1a-dup-confirmed") if c["valid_token"] else (DUP, "1a-dup-ask")
    if c["fp_confirmed_ge14d"]:
        return CREATE, "1a-succeeded-expired"
    if c["fp_canceled"]:
        return CREATE, "1a-canceled"
    if c["fp_nonterminal"] and not c["nt_key_known"]:
        return CREATE, "1a-nonterminal-unknown-ver"
    if c["fp_nonterminal"] and c["nt_key_known"] and not c["m_age_lt14d"]:
        return CREATE, "1a-nonterminal-block-expired"
    return CREATE, "2-fresh"


AXES = {
    "found_by_request_id": [True, False],
    "status": ["succeeded", "canceled", "pending", "unknown"],
    "key_known": [True, False],
    "content_match": [True, False],
    "has_payment_id": [True, False],
    "within_dedup": [True, False],
    "fp_nonterminal": [True, False],
    "fp_confirmed_lt14d": [True, False],  # 14 суток от подтверждения, не от создания записи
    "fp_confirmed_ge14d": [True, False],
    "fp_canceled": [True, False],
    "nt_key_known": [True, False],  # версия ключа незавершённой записи
    "m_age_lt14d": [True, False],
    "cf_key_known": [True, False],  # версия ключа подтверждённой записи
    "valid_token": [True, False],
}
names = list(AXES)
rows, gaps = [], []
for combo in product(*(AXES[n] for n in names)):
    c = dict(zip(names, combo))
    try:
        out, br = dispatch(c)
    except Exception as exc:
        gaps.append((c, repr(exc))); continue
    (rows if out else gaps).append((c, out, br))

print("комбинаций входов:", len(rows), "| без исхода:", len(gaps))
import inspect
_body = inspect.getsource(dispatch)
_unread = [n for n in names if ('"%s"' % n) not in _body]
print("оси, которые диспетчер НЕ читает:", _unread or "нет")
assert not _unread, "непрочитанная ось раздувает число комбинаций, не измеряя ничего"

both_live = sum(
    1 for c, o, b in rows
    if not c["found_by_request_id"] and c["fp_nonterminal"] and c["fp_confirmed_lt14d"]
    and c["nt_key_known"] and c["m_age_lt14d"] and c["cf_key_known"]
)
print("комбинаций одновременного совпадения с незавершённой и подтверждённой (живых):", both_live)
assert both_live > 0, "нормативно обязательная комбинация двух совпадений непредставима"

split_keys = sum(
    1 for c, o, b in rows
    if not c["found_by_request_id"] and c["fp_nonterminal"] and not c["nt_key_known"]
    and c["fp_confirmed_lt14d"] and c["cf_key_known"] and o == DUP
)
print("комбинаций: незавершённая невидима + подтверждённая видима → DUP:", split_keys)
assert split_keys > 0, "раздельные ключи двух поисков непредставимы или не дают DUP"

expired_then_dup = sum(
    1 for c, o, b in rows
    if not c["found_by_request_id"] and c["fp_nonterminal"] and c["nt_key_known"]
    and not c["m_age_lt14d"] and c["fp_confirmed_lt14d"] and c["cf_key_known"]
    and not c["valid_token"] and o == DUP
)
print("комбинаций: истёкшая незавершённая + живая подтверждённая → DUP:", expired_then_dup)
assert expired_then_dup > 0, "истёкшая незавершённая не должна отменять поиск подтверждённых"

expired_invisible_cf = sum(
    1 for c, o, b in rows
    if not c["found_by_request_id"] and c["fp_nonterminal"] and c["nt_key_known"]
    and not c["m_age_lt14d"] and c["fp_confirmed_lt14d"] and not c["cf_key_known"]
    and o == CREATE
)
print("комбинаций: истёкшая незавершённая + подтверждённая неизвестного ключа → CREATE:", expired_invisible_cf)
assert expired_invisible_cf > 0, "истёкшая незавершённая + невидимая подтверждённая должна давать CREATE"

def _live_nt(c):
    return c["fp_nonterminal"] and c["nt_key_known"] and c["m_age_lt14d"]

checks = [
    ("R1 живое незавершённое совпадение не даёт платежа",
     lambda c, o: not c["found_by_request_id"] and c["fp_nonterminal"]
     and c["nt_key_known"] and c["m_age_lt14d"] and o == CREATE),
    ("R2 дубль после успешной оплаты только по действительному токену",
     lambda c, o: not c["found_by_request_id"] and not _live_nt(c)
     and c["fp_confirmed_lt14d"]
     and c["cf_key_known"] and o == CREATE and not c["valid_token"]),
    ("R8 подтверждённая запись известной версии всегда даёт вопрос или создание по токену",
     lambda c, o: not c["found_by_request_id"] and not _live_nt(c)
     and c["fp_confirmed_lt14d"]
     and c["cf_key_known"] and o not in (DUP, CREATE)),
    ("R9 при совпадении с обеими живыми — исход VERIF, не DUP и не CREATE",
     lambda c, o: not c["found_by_request_id"] and c["fp_nonterminal"]
     and c["fp_confirmed_lt14d"] and c["nt_key_known"] and c["m_age_lt14d"]
     and c["cf_key_known"]
     and o != VERIF),
    ("R10 незавершённая с неизвестным ключом не скрывает подтверждённую",
     lambda c, o: not c["found_by_request_id"] and c["fp_nonterminal"]
     and not c["nt_key_known"] and c["fp_confirmed_lt14d"] and c["cf_key_known"]
     and ((not c["valid_token"] and o != DUP) or (c["valid_token"] and o != CREATE))),
    ("R3 succeeded всегда already_paid",
     lambda c, o: c["found_by_request_id"] and c["status"] == "succeeded" and o != ALREADY),
    ("R4 нет тупика у записи без paymentId",
     lambda c, o: c["found_by_request_id"] and c["status"] in ("pending", "unknown")
     and c["key_known"] and c["content_match"] and not c["has_payment_id"]
     and o not in (RETRY, VERIF)),
    ("R5 409 «данные изменились» только для canceled",
     lambda c, o: o == CONFLICT_409 and not (c["found_by_request_id"] and c["status"] == "canceled")),
    ("R6 повтор к оператору только без paymentId и в окне 24 ч",
     lambda c, o: o == RETRY and (c["has_payment_id"] or not c["within_dedup"])),
    ("R7 истёкшая незавершённая не отменяет живую подтверждённую",
     lambda c, o: not c["found_by_request_id"] and c["fp_nonterminal"]
     and c["nt_key_known"] and not c["m_age_lt14d"]
     and c["fp_confirmed_lt14d"] and c["cf_key_known"]
     and ((not c["valid_token"] and o != DUP) or (c["valid_token"] and o != CREATE))),
    ("R7b истёкшая незавершённая без подтверждённой младше 14 суток — новая попытка",
     lambda c, o: not c["found_by_request_id"] and c["fp_nonterminal"]
     and c["nt_key_known"] and not c["m_age_lt14d"]
     and not c["fp_confirmed_lt14d"] and o != CREATE),
    ("R11 истёкшая незавершённая + подтверждённая неизвестного ключа — CREATE, не VERIF и не DUP",
     lambda c, o: not c["found_by_request_id"] and c["fp_nonterminal"]
     and c["nt_key_known"] and not c["m_age_lt14d"]
     and c["fp_confirmed_lt14d"] and not c["cf_key_known"]
     and o != CREATE),
]
failed = False
for label, bad in checks:
    n = sum(1 for c, o, _ in rows if bad(c, o))
    print(("  OK   " if not n else "  ПЛОХО"), label, "" if not n else "(%d)" % n)
    if n:
        failed = True

branches = {}
for _, _, b in rows:
    branches[b] = branches.get(b, 0) + 1
print("\nветви (%d):" % len(branches))
for b in sorted(branches):
    print("  %-32s %5d" % (b, branches[b]))

required = {
    "3", "4-match", "4-mismatch", "4-unknown-key", "5-mismatch", "5-existing",
    "5-continue", "5-beyond-window", "6", "1a-nonterminal-match",
    "1a-nonterminal-block-expired", "1a-nonterminal-unknown-ver",
    "1a-dup-ask", "1a-dup-confirmed", "1a-dup-unknown-ver",
    "1a-succeeded-expired", "1a-canceled", "2-fresh",
}
missing = required - set(branches)
print("обязательные ветви отсутствуют:", missing or "нет")
assert not missing
assert not gaps
assert not failed
print("матрица: полнота и инварианты зелёные")
