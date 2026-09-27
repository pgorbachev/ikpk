import type { ReactNode } from 'react';
import { DateTimePicker, Field } from '@strapi/design-system';
import { useField } from '@strapi/strapi/admin';
import { toWallClockISO } from '../../seminar-management/wall-clock.js';

const MAX_DATE = new Date(2099, 11, 31);

type Props = {
  name: string;
  required?: boolean;
  label?: string;
  hint?: string;
  labelAction?: ReactNode;
  disabled?: boolean;
};

/**
 * Штатный ввод Strapi сохраняет `toISOString()`. День, выбранный в календаре,
 * заменяется днём UTC. Здесь в строку попадают локальные компоненты и сдвиг браузера.
 */
export default function WallClockDateTime({ name, required, label, hint, labelAction, disabled }: Props) {
  const field = useField(name);
  const raw = field.value;
  const parsed = typeof raw === 'string' || raw instanceof Date ? new Date(raw) : null;
  const value = parsed && !Number.isNaN(parsed.getTime()) ? parsed : undefined;

  return (
    <Field.Root name={name} error={field.error} hint={hint} required={required}>
      <Field.Label action={labelAction}>{label}</Field.Label>
      <DateTimePicker
        disabled={disabled}
        clearLabel="Очистить"
        onChange={(date) => {
          field.onChange(name, date ? toWallClockISO(date) : null);
        }}
        onClear={() => field.onChange(name, null)}
        value={value}
        maxDate={MAX_DATE}
      />
      <Field.Hint />
      <Field.Error />
    </Field.Root>
  );
}
