import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Field, TextInput } from '@strapi/design-system';
import { useFetchClient, useField, useForm } from '@strapi/strapi/admin';
import { unstable_useContentManagerContext } from '@strapi/content-manager/strapi-admin';

type Relation = { documentId?: string; apiData?: { documentId?: string } };
type Props = { name: string; required?: boolean; label?: string; hint?: string; labelAction?: ReactNode; disabled?: boolean };
const SEMINAR = 'api::seminar.seminar';
const ENTRY = 'api::schedule-entry.schedule-entry';

/** An empty override inherits only the published seminar, never its draft. */
export default function OccurrenceDuration({ name, required, label, hint, labelAction, disabled }: Props) {
  const duration = useField(name);
  const { id, isCreatingEntry } = unstable_useContentManagerContext();
  const selected = useForm('OccurrenceDuration', (state) => {
    const relation = (state.values as { seminar?: { connect?: Relation[] } }).seminar?.connect?.[0];
    return relation?.documentId ?? relation?.apiData?.documentId;
  });
  const { get } = useFetchClient();
  const getter = useRef(get); getter.current = get;
  const creating = isCreatingEntry || !id || id === 'create';
  const [savedSeminar, setSavedSeminar] = useState<string | null>(null);
  const [relationError, setRelationError] = useState(false);
  const [message, setMessage] = useState('Сначала выберите семинар.');

  useEffect(() => {
    setSavedSeminar(null);
    setRelationError(false);
    if (creating || !id) return;
    let active = true;
    getter.current(`/content-manager/relations/${ENTRY}/${encodeURIComponent(id)}/seminar?pageSize=2&page=1`)
      .then(({ data }) => { if (active) setSavedSeminar(data.results?.[0]?.documentId ?? null); })
      .catch(() => { if (active) setRelationError(true); });
    return () => { active = false; };
  }, [creating, id]);

  const seminarId = selected ?? savedSeminar;
  useEffect(() => {
    if (relationError) { setMessage('Не удалось загрузить связь с семинаром. Обновите страницу.'); return; }
    if (!seminarId) { setMessage('Сначала выберите семинар.'); return; }
    let active = true;
    setMessage('Загрузка опубликованной продолжительности…');
    getter.current(`/content-manager/collection-types/${SEMINAR}/${encodeURIComponent(seminarId)}?status=published`)
      .then(({ data }) => {
        if (!active) return;
        const seminar = data.data;
        if (!seminar?.publishedAt) setMessage('Опубликованная версия семинара отсутствует.');
        else if (typeof seminar.duration === 'string' && seminar.duration.trim()) setMessage(`Из опубликованного семинара: ${seminar.duration.trim()}`);
        else setMessage('В опубликованном семинаре продолжительность не указана.');
      })
      .catch(() => { if (active) setMessage('Не удалось загрузить опубликованную продолжительность. Обновите страницу.'); });
    return () => { active = false; };
  }, [seminarId, relationError]);

  return <Field.Root name={name} error={duration.error} hint={hint} required={required}>
    <Field.Label action={labelAction}>{label}</Field.Label>
    <TextInput name={name} disabled={disabled} placeholder="Оставьте пустым для наследования"
      value={typeof duration.value === 'string' ? duration.value : ''}
      onChange={(event) => duration.onChange(name, event.target.value === '' ? null : event.target.value)} />
    <Field.Hint />
    <Field.Error />
    <p role="status">{message}</p>
  </Field.Root>;
}
