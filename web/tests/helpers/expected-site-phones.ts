import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const web = join(import.meta.dirname, '..', '..');
const source = process.env.CONTENT_SNAPSHOT_DIR ??
  (existsSync(join(web, '.snapshot', 'snapshot.json')) ? join(web, '.snapshot') : join(web, '..', 'fixtures', 'content-snapshot'));
const snapshot = JSON.parse(readFileSync(join(source, 'snapshot.json'), 'utf8'));
const contacts = snapshot.content.types.static_pages.find((page: { slug: string }) => page.slug === 'kontakty');
const center = String(contacts.center_phone).replace(/\D/g, '');
const manager = String(contacts.manager_phone).replace(/\D/g, '');
if (!/^7\d{10}$/.test(center) || !/^7\d{10}$/.test(manager)) throw new Error('В снимке нет пары телефонов /kontakty');

const parts = /^7(\d{3})(\d{3})(\d{2})(\d{2})$/;
export const CITY_PHONE = center.replace(parts, '+7 ($1) $2-$3-$4');
export const MOBILE_PHONE = manager.replace(parts, '+7 $1 $2-$3-$4');
export const CITY_TEL = `tel:+${center}`;
export const MOBILE_TEL = `tel:+${manager}`;
