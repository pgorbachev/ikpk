import type { Core } from '@strapi/strapi';

const config = ({ env }: Core.Config.Shared.ConfigParams): Core.Config.Server => ({
  // Ревью PR #186, третий раунд (H6): `bootstrap-vps.sh` не разворачивает Strapi и не
  // ставит firewall — единственный барьер между `merge` и админкой, открытой в интернет
  // напрямую (минуя vhost, его TLS и `ADMIN_DOMAIN`), был именно этот дефолт. Топология
  // (`scripts/bootstrap-vps.sh`, nginx `proxy_pass http://127.0.0.1:1337`) уже держит
  // Strapi локальным — loopback ничего не стоит для нормальной раздачи и требует явного
  // `HOST=0.0.0.0` в окружении, если кому-то понадобится слушать все интерфейсы.
  host: env('HOST', '127.0.0.1'),
  port: env.int('PORT', 1337),
  app: {
    keys: env.array('APP_KEYS'),
  },
});

export default config;
