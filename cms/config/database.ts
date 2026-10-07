import path from 'path';
import type { Core } from '@strapi/strapi';

const config = ({ env }: Core.Config.Shared.ConfigParams): Core.Config.Database => {
  const client = env('DATABASE_CLIENT', 'sqlite');

  const connections = {
    mysql: {
      connection: {
        host: env('DATABASE_HOST', 'localhost'),
        port: env.int('DATABASE_PORT', 3306),
        database: env('DATABASE_NAME', 'strapi'),
        user: env('DATABASE_USERNAME', 'strapi'),
        password: env('DATABASE_PASSWORD', 'strapi'),
        ssl: env.bool('DATABASE_SSL', false) && {
          key: env('DATABASE_SSL_KEY', undefined),
          cert: env('DATABASE_SSL_CERT', undefined),
          ca: env('DATABASE_SSL_CA', undefined),
          capath: env('DATABASE_SSL_CAPATH', undefined),
          cipher: env('DATABASE_SSL_CIPHER', undefined),
          rejectUnauthorized: env.bool('DATABASE_SSL_REJECT_UNAUTHORIZED', true),
        },
      },
      pool: { min: env.int('DATABASE_POOL_MIN', 2), max: env.int('DATABASE_POOL_MAX', 10) },
    },
    postgres: {
      connection: {
        connectionString: env('DATABASE_URL'),
        host: env('DATABASE_HOST', 'localhost'),
        port: env.int('DATABASE_PORT', 5432),
        database: env('DATABASE_NAME', 'strapi'),
        user: env('DATABASE_USERNAME', 'strapi'),
        password: env('DATABASE_PASSWORD', 'strapi'),
        ssl: env.bool('DATABASE_SSL', false) && {
          key: env('DATABASE_SSL_KEY', undefined),
          cert: env('DATABASE_SSL_CERT', undefined),
          ca: env('DATABASE_SSL_CA', undefined),
          capath: env('DATABASE_SSL_CAPATH', undefined),
          cipher: env('DATABASE_SSL_CIPHER', undefined),
          rejectUnauthorized: env.bool('DATABASE_SSL_REJECT_UNAUTHORIZED', true),
        },
        schema: env('DATABASE_SCHEMA', 'public'),
      },
      pool: { min: env.int('DATABASE_POOL_MIN', 2), max: env.int('DATABASE_POOL_MAX', 10) },
    },
    sqlite: {
      connection: {
        // resolve, а не join: DATABASE_FILENAME на сервере АБСОЛЮТЕН
        // (/var/lib/ikpk-cms/<env>/data/data.db), а join абсолютный сегмент не уважает и
        // склеивает его с каталогом релиза. База оказалась бы ВНУТРИ релиза и умирала бы
        // при каждой выкатке. resolve верен и для относительного значения по умолчанию.
        filename: path.resolve(__dirname, '..', '..', env('DATABASE_FILENAME', '.tmp/data.db')),
      },
      useNullAsDefault: true,
      // Поиск админки на SQLite — `поле LIKE ?`, а встроенный LIKE не различает регистр только
      // у латиницы: «мой семинар» не находил «Мой семинар». На Postgres (прод) поиск идёт через
      // ILIKE и этой проблемы нет. Подменяем LIKE на версию, понимающую регистр Юникода.
      pool: {
        afterCreate(db: SqliteHandle, done: () => void) {
          db.function('like', { varargs: true, deterministic: true }, unicodeLike);
          done();
        },
      },
    },
  };

  return {
    connection: {
      client,
      ...connections[client],
      acquireConnectionTimeout: env.int('DATABASE_CONNECTION_TIMEOUT', 60000),
    },
  };
};

type SqliteHandle = {
  function: (name: string, options: object, fn: (...args: unknown[]) => unknown) => void;
};

const likePatterns = new Map<string, RegExp>();

// SQLite вызывает `X LIKE Y ESCAPE Z` как like(Y, X, Z): шаблон первым.
function unicodeLike(pattern: unknown, value: unknown, escape?: unknown): number | null {
  if (pattern == null || value == null) return null;
  const key = `${escape ?? ''}\u0000${pattern}`;
  let regex = likePatterns.get(key);
  if (!regex) {
    let source = '';
    const chars = [...String(pattern)];
    for (let i = 0; i < chars.length; i += 1) {
      const char = chars[i];
      if (escape != null && char === String(escape) && i + 1 < chars.length) {
        source += chars[(i += 1)].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      } else if (char === '%') source += '.*';
      else if (char === '_') source += '.';
      else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    regex = new RegExp(`^${source}$`, 'isu');
    likePatterns.set(key, regex);
  }
  return regex.test(String(value)) ? 1 : 0;
}

export default config;
