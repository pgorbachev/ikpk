# Архив дерева сборки сайта: только файлы коммита HEAD.
# Игнорируемые и посторонние файлы рабочего каталога в него не входят.
# Иначе web/.env уехал бы на стенд, а объявленный SHA описывал бы другое дерево.
site_build_archive() {
  local root="$1"
  # cms/src нужен съёму: скрипт сверяет ответ CMS со схемами коммита, а не с установленным
  # артефактом. Без них кнопка проходит REST и падает на отсутствующем schema.json.
  # Панели и карта адресов не живут в CMS. Съём копирует их из закреплённой фикстуры,
  # а сборка читает collapsible_panels.json безусловно. Без этих двух файлов кнопка
  # доходит до рендера /oplata и падает ENOENT.
  git -C "$root" archive --format=tar.gz HEAD -- web media-originals cms/src \
    fixtures/content-snapshot/collapsible_panels.json \
    fixtures/content-snapshot/url_map.csv
}
