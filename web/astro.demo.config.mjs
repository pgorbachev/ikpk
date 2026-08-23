// @ts-check
// Конфигурация ТОЛЬКО для preview демо-стенда.
//
// Зачем отдельный файл. `astro build` умеет `--outDir` и потому собирает демо в
// `dist-demo` прямо из командной строки (`npm run build:demo`). У `astro preview`
// такого флага НЕТ — он берёт `outDir` из конфигурации, а неизвестные флаги
// принимает молча. Из-за этого `astro preview --outDir dist-demo` поднимал сервер
// над боевым `dist`, и демо-тесты Playwright проверяли боевую сборку под именем
// демонстрационной. Проверено: сервер, запущенный с этим флагом, отдавал
// `data-payment-demo="false"`, то есть предмет проверки подменялся молча.
//
// Конфигурация обязана лежать внутри `web/`: путь к ней разрешается относительно
// корня проекта, и файл снаружи не загружается (`Preview server process exited
// before becoming ready`).
import base from './astro.config.mjs';

export default { ...base, outDir: 'dist-demo' };
