import React, { useEffect, useRef, useState } from 'react';
import { useFetchClient, useForm } from '@strapi/strapi/admin';
import { unstable_useContentManagerContext } from '@strapi/content-manager/strapi-admin';
import { useLocation, useNavigate } from 'react-router-dom';
// Strapi 5.51.2 does not export its relation input. Keep the native input for
// every relation outside these two content types; verify the path on upgrades.
// @ts-expect-error internal, version-pinned Strapi module
import { RelationsInput } from '@ikpk/native-relations';

const SEMINAR = 'api::seminar.seminar';
const ENTRY = 'api::schedule-entry.schedule-entry';
type Relation = { id: number; documentId: string; name?: string; label?: string; admin_label?: string; __temp_key__?: string; apiData?: { documentId?: string } };
type Props = { name: string; disabled?: boolean; [key: string]: unknown };
type Fetcher = (url: string) => Promise<{ data: { results: Relation[]; pagination: { pageCount: number } } }>;

async function allRelations(get: Fetcher, model: string, id: string, field: string): Promise<Relation[]> {
  const out: Relation[] = [];
  let page = 1;
  let pages: number;
  do {
    const response = await get(`/content-manager/relations/${model}/${encodeURIComponent(id)}/${field}?pageSize=100&page=${page}`);
    out.push(...response.data.results);
    pages = response.data.pagination.pageCount;
    page += 1;
  } while (page <= pages);
  return out;
}

function SeminarOccurrences({ id, disabled }: { id?: string; disabled?: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { get } = useFetchClient();
  const getter = useRef(get); getter.current = get;
  const [rows, setRows] = useState<Relation[]>([]);
  const [error, setError] = useState('');
  const saved = Boolean(id && id !== 'create' && !location.pathname.includes('/clone/'));
  useEffect(() => {
    if (!saved || !id) return;
    let active = true;
    allRelations(getter.current as Fetcher, SEMINAR, id, 'schedule_entries').then(data => {
      if (active) { setRows(data); setError(''); }
    }).catch(() => { if (active) setError('Не удалось загрузить проведения. Обновите страницу.'); });
    return () => { active = false; };
  }, [id, saved]);
  const go = (destination: string) => {
    navigate(destination);
  };
  const source = encodeURIComponent(id ?? '');
  return <section aria-label="Проведения семинара">
    <p>Проведения</p>
    {error && <p role="alert">{error}</p>}
    <ul>{rows.map(row => <li key={row.documentId}>
      <button type="button" onClick={() => go(`/content-manager/collection-types/${ENTRY}/${encodeURIComponent(row.documentId)}?fromSeminar=${source}`)}>{row.admin_label ?? row.label ?? row.name ?? row.documentId}</button>
    </li>)}</ul>
    <button type="button" disabled={disabled} onClick={() => saved ? go(`/content-manager/collection-types/${ENTRY}/create?fromSeminar=${source}`) : setError('Сначала сохраните семинар')}>Создать проведение</button>
  </section>;
}

function SeminarRelation(props: Props) {
  const { id, isCreatingEntry } = unstable_useContentManagerContext();
  const location = useLocation();
  const navigate = useNavigate();
  const from = new URLSearchParams(location.search).get('fromSeminar');
  const setValue = useForm('SeminarRelation', state => state.onChange);
  const { get } = useFetchClient();
  const getter = useRef(get); getter.current = get;
  const [error, setError] = useState('');
  const creating = isCreatingEntry || !id || id === 'create';
  useEffect(() => {
    if (!creating || !from) return;
    let active = true;
    getter.current(`/content-manager/collection-types/${SEMINAR}/${encodeURIComponent(from)}`).then(({ data }) => {
      if (!active) return;
      const seminar = data.data;
      setValue('seminar.connect', [{ id: seminar.id, documentId: seminar.documentId, label: seminar.name, name: seminar.name, __temp_key__: 'a0', href: `../collection-types/${SEMINAR}/${seminar.documentId}`, apiData: { id: seminar.id, documentId: seminar.documentId, isTemporary: true } }]);
      setError('');
    }).catch(() => { if (active) setError('Не удалось загрузить семинар. Вернитесь и попробуйте снова.'); });
    return () => { active = false; };
  }, [creating, from, setValue]);
  return <><RelationsInput {...props} disabled={props.disabled || !creating || Boolean(from)} />{error && <p role="alert">{error}</p>}{creating && from && <button type="button" onClick={() => navigate(`/content-manager/collection-types/${SEMINAR}/${encodeURIComponent(from)}`)}>Отмена</button>}</>;
}

function OccurrenceTeachers({ id, creating, disabled }: { id?: string; creating: boolean; disabled?: boolean }) {
  const formSeminar = useForm('OccurrenceTeachers', state => (state.values as { seminar?: { connect?: Relation[] } }).seminar?.connect?.[0]);
  const setValue = useForm('OccurrenceTeachers', state => state.onChange);
  const { get } = useFetchClient();
  const getter = useRef(get); getter.current = get;
  const [seminarId, setSeminarId] = useState<string | null>(null);
  const [available, setAvailable] = useState<Relation[]>([]);
  const [availableSeminar, setAvailableSeminar] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<Relation[]>([]);
  const [selected, setSelected] = useState<Relation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const activeSeminar = formSeminar?.documentId ?? formSeminar?.apiData?.documentId ?? seminarId;
  useEffect(() => {
    if (creating || !id) { setSeminarId(null); setBaseline([]); return; }
    let active = true;
    Promise.all([
      allRelations(getter.current as Fetcher, ENTRY, id, 'seminar'),
      allRelations(getter.current as Fetcher, ENTRY, id, 'teachers'),
    ]).then(([seminars, teachers]) => {
      if (!active) return;
      setSeminarId(seminars[0]?.documentId ?? null);
      // Strapi returns relation rows in the reverse of their persisted ordering.
      const ordered = [...teachers].reverse();
      setBaseline(ordered); setSelected(ordered);
    }).catch(() => { if (active) setError('Не удалось загрузить преподавателей проведения. Обновите страницу.'); });
    return () => { active = false; };
  }, [creating, id]);
  useEffect(() => {
    if (!activeSeminar) { setAvailable([]); setAvailableSeminar(null); setLoading(false); if (creating) setSelected([]); return; }
    let active = true;
    setLoading(true);
    allRelations(getter.current as Fetcher, SEMINAR, activeSeminar, 'teachers').then(rows => {
      if (!active) return;
      setAvailable(rows); setAvailableSeminar(activeSeminar); setError(''); setLoading(false);
      if (creating) {
        const next = rows.length === 1 ? rows : [];
        setSelected(next);
        setValue('teachers.disconnect', []);
        setValue('teachers.connect', next.map(row => ({ ...row, label: row.name ?? row.label, __temp_key__: 'a0', apiData: { id: row.id, documentId: row.documentId, isTemporary: true } })));
      }
    }).catch(() => { if (active) { setLoading(false); setError('Не удалось загрузить преподавателей семинара. Обновите страницу.'); } });
    return () => { active = false; };
  }, [activeSeminar, creating, setValue]);
  const update = (next: Relation[]) => {
    setSelected(next);
    const selectedIds = new Set(next.map(row => row.documentId));
    setValue('teachers.disconnect', baseline.filter(row => !selectedIds.has(row.documentId)).map(row => ({ id: row.id, apiData: { id: row.id, documentId: row.documentId } })));
    // Apply reversed entries at the start so the final order matches the editor.
    setValue('teachers.connect', [...next].reverse().map((row, index) => ({ ...row, label: row.name ?? row.label, __temp_key__: `a${index}`, apiData: { id: row.id, documentId: row.documentId, isTemporary: !baseline.some(old => old.documentId === row.documentId), position: { start: true } } })));
  };
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= selected.length) return;
    const next = [...selected]; [next[index], next[target]] = [next[target], next[index]]; update(next);
  };
  const selectedIds = new Set(selected.map(row => row.documentId));
  const availableIds = new Set(available.map(row => row.documentId));
  const availabilityReady = Boolean(activeSeminar && availableSeminar === activeSeminar && !loading && !error);
  return <section aria-label="Преподаватели проведения">
    <p>Преподаватели проведения</p>
    {error && <p role="alert">{error}</p>}
    {!activeSeminar && <p>Сначала выберите семинар.</p>}
    {loading && <p>Загрузка преподавателей…</p>}
    <ol>{selected.map((row, index) => <li key={row.documentId}>
      {row.name ?? row.label ?? row.documentId} {!availableIds.has(row.documentId) && availabilityReady && <small> (ранее назначен, сейчас отсутствует в семинаре)</small>}
      <button type="button" disabled={disabled || index === 0} aria-label={`Поднять ${row.name ?? row.label ?? ''}`} onClick={() => move(index, -1)}>↑</button>
      <button type="button" disabled={disabled || index === selected.length - 1} aria-label={`Опустить ${row.name ?? row.label ?? ''}`} onClick={() => move(index, 1)}>↓</button>
      <button type="button" disabled={disabled || loading || Boolean(error)} onClick={() => update(selected.filter(item => item.documentId !== row.documentId))}>Удалить</button>
    </li>)}</ol>
    {availabilityReady && available.filter(row => !selectedIds.has(row.documentId)).map(row => <button key={row.documentId} type="button" disabled={disabled || loading || Boolean(error)} onClick={() => update([...selected, row])}>Добавить {row.name ?? row.label ?? row.documentId}</button>)}
  </section>;
}

export function OccurrenceRelations(props: Props) {
  const { model, id, isCreatingEntry } = unstable_useContentManagerContext();
  if (model === SEMINAR && props.name === 'schedule_entries') return <SeminarOccurrences id={id} disabled={props.disabled} />;
  if (model === ENTRY && props.name === 'seminar') return <SeminarRelation {...props} />;
  if (model === ENTRY && props.name === 'teachers') return <OccurrenceTeachers id={id} creating={isCreatingEntry || !id || id === 'create'} disabled={props.disabled} />;
  return <RelationsInput {...props} />;
}
