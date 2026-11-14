import { useEffect, type ReactNode } from 'react';
import { Field, TextInput } from '@strapi/design-system';
import { useField } from '@strapi/strapi/admin';

type Props = {
  name: string;
  required?: boolean;
  label?: string;
  hint?: string;
  labelAction?: ReactNode;
  disabled?: boolean;
};

export default function OccurrenceCity({ name, required, label, hint, labelAction, disabled }: Props) {
  const city = useField(name);
  const online = useField('isOnline');
  const isOnline = online.value === true;
  useEffect(() => {
    if (isOnline && city.value) city.onChange(name, null);
  }, [isOnline, city.value, city.onChange, name]);

  return (
    <Field.Root name={name} error={city.error} hint={hint} required={required}>
      <Field.Label action={labelAction}>{label}</Field.Label>
      <TextInput
        name={name}
        disabled={disabled || isOnline}
        value={!isOnline && typeof city.value === 'string' ? city.value : ''}
        onChange={(event) => city.onChange(name, event.target.value)}
      />
      <Field.Hint />
      <Field.Error />
    </Field.Root>
  );
}
