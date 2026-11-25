import { Link } from '@strapi/design-system';
import { useParams } from 'react-router-dom';
// @ts-expect-error internal, version-pinned Strapi module
import { FormLayout as NativeFormLayout } from '@ikpk/native-form-layout';

type Field = { name: string; size: number };
type Props = {
  layout: Field[][][];
  document: { model: string; document?: { slug?: string; documentId?: string } };
  hasBackground?: boolean;
};

const firstFields = ['title', 'center_phone', 'manager_phone'];

function formatContactField(field: Field) {
  if (field.name === 'slug') {
    return {
      ...field,
      label: 'Адрес страницы',
      disabled: true,
      hint: <Link href="/kontakty" isExternal>Открыть страницу</Link>,
    };
  }
  if (field.name === 'body') {
    return { ...field, hint: 'На странице «Контакты» этот текст не отображается.' };
  }
  return field;
}

// Strapi's layout hook receives the model layout before the record is known.
// Here the edit view supplies the saved document along with its configured fields.
export function FormLayout(props: Props) {
  const { origin } = useParams();
  const saved = props.document.document;
  if (props.document.model !== 'api::page.page' || origin || !saved?.documentId || saved.slug !== 'kontakty') {
    return <NativeFormLayout {...props} />;
  }

  const fields = props.layout.flat(2);
  const [title, center, manager] = firstFields.map(name => fields.find(field => field.name === name));
  const phones = [];
  if (center) phones.push({ ...center, size: 6, hint: 'Здесь задаются телефоны для сайта.' });
  if (manager) phones.push({ ...manager, size: 6 });

  const panels = props.layout.map(panel => panel
    .map(row => row.filter(field => !firstFields.includes(field.name)).map(formatContactField))
    .filter(row => row.length > 0))
    .filter(panel => panel.length > 0);
  const [firstPanel = [], ...otherPanels] = panels;
  const firstRows = [title ? [title] : [], phones].filter(row => row.length > 0);
  const layout = [[...firstRows, ...firstPanel], ...otherPanels];
  return <NativeFormLayout {...props} layout={layout} />;
}
