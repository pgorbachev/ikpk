import { mergeConfig, type UserConfig } from 'vite';
import { resolve } from 'node:path';
import { createAdminLoginRedirectPlugin } from './admin-login-redirect-plugin';
import { createTeacherRelationsPlugin } from './teacher-relations-plugin';

export default (config: UserConfig) => {
  // Important: always return the modified config
  return mergeConfig(config, {
    cacheDir: resolve(process.cwd(), '.vite-cache/admin'),
    plugins: [createAdminLoginRedirectPlugin(), createTeacherRelationsPlugin()],
    resolve: {
      alias: {
        '@': '/src',
      },
    },
  });
};
