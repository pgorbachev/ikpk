import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Core } from '@strapi/strapi';
import { env } from '@strapi/utils';
import middlewaresConfig from '../../config/middlewares';

const DEFAULT_ORIGIN = 'https://ikpk.su';
const OUTSIDE_ORIGIN = 'https://example.com';

type ExportedConfig =
  | Core.Config.Middlewares
  | ((params: Core.Config.Shared.ConfigParams) => Core.Config.Middlewares);

type NamedMiddleware = {
  name?: string;
  config?: {
    origin?: unknown;
  };
};

function withCorsOrigins(value: string | undefined, run: () => void) {
  const previous = process.env.CMS_CORS_ORIGINS;
  if (value === undefined) delete process.env.CMS_CORS_ORIGINS;
  else process.env.CMS_CORS_ORIGINS = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.CMS_CORS_ORIGINS;
    else process.env.CMS_CORS_ORIGINS = previous;
  }
}

function loadMiddlewares(): Core.Config.Middlewares {
  const exported = middlewaresConfig as ExportedConfig;
  const resolved = typeof exported === 'function' ? exported({ env }) : exported;
  assert.ok(Array.isArray(resolved), 'middleware config must resolve to an array');
  return resolved;
}

function corsEntry(middlewares: Core.Config.Middlewares): NamedMiddleware {
  const entry = middlewares.find((item) => {
    if (item === 'strapi::cors') return true;
    return typeof item === 'object' && item !== null && 'name' in item && item.name === 'strapi::cors';
  });
  assert.ok(entry, 'strapi::cors must stay enabled');
  if (typeof entry === 'string') return { name: entry };
  return entry as NamedMiddleware;
}

function configuredOrigin(middlewares: Core.Config.Middlewares): unknown {
  return corsEntry(middlewares).config?.origin;
}

test('allows only the configured site origin when CMS_CORS_ORIGINS is unset', () => {
  withCorsOrigins(undefined, () => {
    const origin = configuredOrigin(loadMiddlewares());
    assert.deepEqual(origin, [DEFAULT_ORIGIN]);
    assert.ok(Array.isArray(origin), 'CORS origin must be an explicit allowlist');
    assert.equal(origin.includes('*'), false);
    assert.notEqual(origin, '*');
    assert.notEqual(typeof origin, 'function');
  });
});

test('reads the site origin list from CMS_CORS_ORIGINS', () => {
  withCorsOrigins(`${DEFAULT_ORIGIN},https://staging.ikpk.su`, () => {
    const origin = configuredOrigin(loadMiddlewares());
    assert.deepEqual(origin, [DEFAULT_ORIGIN, 'https://staging.ikpk.su']);
    assert.ok(Array.isArray(origin));
    assert.equal(origin.includes('*'), false);
  });
});

test('rejects an origin outside the allowlist', () => {
  withCorsOrigins(undefined, () => {
    const origin = configuredOrigin(loadMiddlewares());
    assert.ok(
      Array.isArray(origin),
      'CORS origin must be an explicit allowlist, not a wildcard or an open reflect-any-origin setting',
    );
    assert.equal(origin.includes('*'), false);
    assert.equal(origin.includes(OUTSIDE_ORIGIN), false);
    assert.equal(origin.includes(DEFAULT_ORIGIN), true);
  });
});

test('keeps middleware order and leaves security unchanged', () => {
  withCorsOrigins(undefined, () => {
    const middlewares = loadMiddlewares();
    const names = middlewares.map((item) =>
      typeof item === 'string' ? item : (item as NamedMiddleware).name,
    );
    assert.deepEqual(names, [
      'strapi::logger',
      'strapi::errors',
      'strapi::security',
      'strapi::cors',
      'strapi::poweredBy',
      'strapi::query',
      'strapi::body',
      'strapi::session',
      'strapi::favicon',
      'strapi::public',
    ]);
    assert.equal(middlewares[2], 'strapi::security');
  });
});
