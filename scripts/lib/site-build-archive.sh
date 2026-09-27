# Архив дерева сборки сайта: только файлы коммита HEAD.
# Игнорируемые и посторонние файлы рабочего каталога в него не входят.
# Иначе web/.env уехал бы на стенд, а объявленный SHA описывал бы другое дерево.
site_build_archive() {
  local root="$1"
  git -C "$root" archive --format=tar.gz HEAD -- web media-originals
}
