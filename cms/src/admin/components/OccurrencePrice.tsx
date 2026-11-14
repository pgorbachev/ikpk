import { useEffect, useRef, type ReactNode } from 'react';
import { Field, TextInput } from '@strapi/design-system';
import { useField } from '@strapi/strapi/admin';

type Props = { name: string; required?: boolean; label?: string; hint?: string; labelAction?: ReactNode; disabled?: boolean };

export default function OccurrencePrice({ name, required, label, hint, labelAction, disabled }: Props) {
  const price = useField(name);
  const freeField = useField('isFree');
  const isFree = freeField.value === true;
  const wasFree = useRef(isFree);
  const switchingToFree = isFree && !wasFree.current;
  const clearOnSwitch = !isFree && wasFree.current && price.value != null && Number(price.value) === 0;
  useEffect(() => {
    if (switchingToFree) price.onChange(name, 0);
    else if (clearOnSwitch) price.onChange(name, null);
    wasFree.current = isFree;
  }, [isFree, switchingToFree, clearOnSwitch, price.onChange, name]);
  const invalidFree = isFree && (price.value == null || price.value === '' || Number(price.value) !== 0);
  const value = switchingToFree ? '0' : clearOnSwitch || price.value == null ? '' : String(price.value);
  return (
    <Field.Root name={name} error={price.error} hint={hint} required={required}>
      <Field.Label action={labelAction}>{label}</Field.Label>
      <TextInput name={name} type="number" min="0" disabled={disabled || (isFree && (!invalidFree || switchingToFree || freeField.initialValue !== true))} value={value}
        onChange={(event) => price.onChange(name, event.target.value === '' ? null : Number(event.target.value))} />
      <Field.Hint />
      <Field.Error />
    </Field.Root>
  );
}
