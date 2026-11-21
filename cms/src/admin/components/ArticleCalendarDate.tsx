import { forwardRef, useLayoutEffect, useRef } from 'react';
import type { FocusEventHandler, ReactNode } from 'react';
import { Field, useComposedRefs } from '@strapi/design-system';
import { useField, useFocusInputField } from '@strapi/strapi/admin';
import { DateTimeInput as StrapiDateTimeInput } from '@ikpk/strapi-date-time-input';
import { moscowCalendarDate, moscowCalendarDateISO, todayInMoscow } from '../../lib/article-publication';

type Props = {
  name: string;
  required?: boolean;
  label?: ReactNode;
  hint?: ReactNode;
  labelAction?: ReactNode;
  disabled?: boolean;
  type?: string;
  maxDate?: Date;
  'aria-label'?: string;
  onFocus?: FocusEventHandler<HTMLInputElement>;
  onBlur?: FocusEventHandler<HTMLInputElement>;
};

const ArticleCalendarDate = forwardRef<HTMLInputElement, Props>(function ArticleCalendarDate(props, forwardedRef) {
  const { name, required, label, hint, labelAction, disabled, onFocus, onBlur } = props;
  const field = useField(name);
  const fieldRef = useFocusInputField<HTMLInputElement>(name);
  const ref = useComposedRefs(forwardedRef, fieldRef);
  const isArticleDate = name === 'published_date' && window.location.pathname.includes('api::article.article');
  const isCreatingArticle = isArticleDate && /\/create\/?$/.test(window.location.pathname);
  const initialized = useRef(false);
  useLayoutEffect(() => {
    if (!isCreatingArticle || initialized.current) return;
    initialized.current = true;
    if (field.value == null) field.onChange(name, moscowCalendarDateISO(todayInMoscow()));
  }, [field.onChange, field.value, isCreatingArticle, name]);

  if (!isArticleDate) {
    return <StrapiDateTimeInput {...props} name={name} ref={ref} />;
  }

  const value = moscowCalendarDate(field.value) || (isCreatingArticle && !initialized.current ? todayInMoscow() : '');
  return (
    <Field.Root name={name} error={field.error} hint={hint} required={required}>
      <Field.Label action={labelAction}>{label}</Field.Label>
      <input
        id={name}
        name={name}
        type="date"
        aria-label={props['aria-label'] ?? (typeof label === 'string' ? label : 'Дата публикации')}
        disabled={disabled}
        required={required}
        ref={ref}
        value={value}
        onFocus={onFocus}
        onBlur={onBlur}
        onChange={(event) => field.onChange(name, event.target.value ? moscowCalendarDateISO(event.target.value) : null)}
      />
      <Field.Hint />
      <Field.Error />
    </Field.Root>
  );
});

export default ArticleCalendarDate;
