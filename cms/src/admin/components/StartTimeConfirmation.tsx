import { useField } from '@strapi/strapi/admin';

type Props = { name: string; label?: string; hint?: string; disabled?: boolean };

/** Show the conversion in the editor's declared zone before asking for confirmation. */
export default function StartTimeConfirmation({ name, label, hint, disabled }: Props) {
  const field = useField(name);
  const instant = useField('startsAtInstant').value;
  const zone = useField('startTimeZone').value;
  let preview = 'Укажите точный момент начала и зону проведения.';
  let valid = false;
  try {
    if (typeof instant === 'string' && typeof zone === 'string' && instant && zone) {
      preview = new Intl.DateTimeFormat('ru-RU', {
        timeZone: zone, dateStyle: 'full', timeStyle: 'long',
      }).format(new Date(instant)) + ` (${zone})`;
      valid = true;
    }
  } catch { preview = 'Проверьте момент начала и имя зоны IANA.'; }
  return (
    <div>
      <p>{preview}</p>
      <label>
        <input type="checkbox" checked={field.value === true} disabled={disabled || !valid}
          onChange={(event) => field.onChange(name, event.target.checked)} />{' '}{label}
      </label>
      <p>{hint}</p>
      {field.error && <p role="alert">{field.error}</p>}
    </div>
  );
}
