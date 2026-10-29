import { mergeConfig, type UserConfig } from 'vite';
import { resolve } from 'node:path';
import { createAdminLoginRedirectPlugin } from './admin-login-redirect-plugin';
import { createTeacherRelationsPlugin } from './teacher-relations-plugin';

export default (config: UserConfig) => {
  // Important: always return the modified config
  const databaseClient = process.env.DATABASE_CLIENT ?? 'sqlite';
  return mergeConfig(config, {
    cacheDir: resolve(process.cwd(), '.vite-cache/admin'),
    define: { __IKPK_DATABASE_CLIENT__: JSON.stringify(databaseClient) },
    plugins: [
      createAdminLoginRedirectPlugin(),
      ...(databaseClient === 'sqlite' ? [createTeacherRelationsPlugin()] : []),
    ],
    resolve: {
      alias: {
        '@': '/src',
      },
    },
  });
};
