# Backlog: связанные домены ИКПК

Задачи по доменам **вне scope** ребилда ikpk.su, зафиксированные в
[discovery/domain_strategy.md](../discovery/domain_strategy.md) и плане 004 (§5.7).
Все требуют доступов к сторонним админкам — включены в
[docs/client-requests.md](client-requests.md).

Статусы: ⬜ не начато | 🔑 ждёт доступа | ✅ сделано

| # | Домен | Задача | Оценка | Нужен доступ | Статус |
|---|-------|--------|--------|--------------|--------|
| 1 | medshop.ikpk.su | **Закрыть**: 301-редирект medshop.ikpk.su → kinezio.shop (один магазин = один SEO-вес; kinezio.shop основной — на него ведёт навигация ikpk.su) | ~1 ч | WP-админка medshop / хостинг | ⬜ |
| 2 | ikpk812.ru (Moodle) | `<meta name="robots" content="noindex">` на все страницы (robots.txt `Disallow: /` НЕ гарантирует деиндексацию) | ~1 ч | Админка Moodle | ⬜ |
| 3 | kinezio.shop | Исправить title «woocommerce» на осмысленный | ~5 мин | WP-админка kinezio.shop | ⬜ |
| 4 | mudriydoctor.ru | Добавить директиву Sitemap в robots.txt | ~10 мин | WP-админка / хостинг | ⬜ |

## Связанные решения, реализуемые в самом ребилде (НЕ этот backlog)

- «Фото» (Яндекс.Диск) → `rel="nofollow noopener"` — Этап 3 (SEO-пакет)
- kinezio.shop / mudriydoctor.ru в навигации → `rel="noopener"` — Этап 3
- Убрать ссылку `staging.ikpk.su/promotions` (утечка staging) + grep-гейт
  на 0 ссылок staging/medshop в dist/ — Этап 3

## Порядок

Приоритет: #1 (дубль магазина размывает SEO-вес прямо сейчас) → #2 → #3 → #4.
Ни одна задача не блокирует go-live ikpk.su; делать по мере получения доступов.
