interface ContactPage {
  slug?: unknown;
  legacy_id?: unknown;
  center_phone?: unknown;
  manager_phone?: unknown;
}

function formattedPhone(value: unknown, field: 'center_phone' | 'manager_phone') {
  const digits = typeof value === 'string' ? value.replace(/[ ()-]/g, '') : '';
  const parts = /^\+7([0-9]{3})([0-9]{3})([0-9]{2})([0-9]{2})$/.exec(digits);
  if (!parts) throw new Error(`Page /kontakty: некорректное поле ${field}, нужен +7 и десять цифр`);
  const [, code, prefix, first, last] = parts;
  return {
    text: field === 'center_phone'
      ? `+7 (${code}) ${prefix}-${first}-${last}`
      : `+7 ${code} ${prefix}-${first}-${last}`,
    href: `tel:${digits}`,
  };
}

export function siteContactPhones(pages: ContactPage[]) {
  const contacts = pages.filter((page) => page.slug === 'kontakty' || page.legacy_id === 'kontakty');
  if (contacts.length !== 1 || contacts[0].slug !== 'kontakty' || contacts[0].legacy_id !== 'kontakty') {
    throw new Error('В снимке должна быть одна опубликованная Page /kontakty с legacy_id kontakty');
  }
  return {
    center: formattedPhone(contacts[0].center_phone, 'center_phone'),
    manager: formattedPhone(contacts[0].manager_phone, 'manager_phone'),
  };
}
