export const SITE_PHONE_LABELS = {
  center_phone: 'Телефон центра',
  manager_phone: 'Мобильный телефон менеджера',
} as const;

export type PhoneField = keyof typeof SITE_PHONE_LABELS;
export const PHONE_FIELDS = Object.keys(SITE_PHONE_LABELS) as PhoneField[];

export function checkPagePhones(identifier: unknown, values: Record<string, unknown>, publishing: boolean) {
  for (const field of PHONE_FIELDS) {
    const value = values[field];
    if (identifier !== 'kontakty') {
      if (value != null && value !== '') {
        return { field, message: `«${SITE_PHONE_LABELS[field]}» можно задать только на странице контактов.` };
      }
    } else if (publishing && (typeof value !== 'string' || !/^\+7[0-9]{10}$/.test(value.replace(/[ ()-]/g, '')))) {
      return { field, message: `«${SITE_PHONE_LABELS[field]}» — введите +7 и десять цифр. Допустимы пробелы, скобки и дефисы.` };
    }
  }
}
