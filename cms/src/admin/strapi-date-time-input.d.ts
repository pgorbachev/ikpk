declare module '@ikpk/strapi-date-time-input' {
  import type { FocusEventHandler, ForwardRefExoticComponent, ReactNode, RefAttributes } from 'react';

  type DateTimeInputProps = {
    name: string;
    type?: string;
    required?: boolean;
    disabled?: boolean;
    label?: ReactNode;
    hint?: ReactNode;
    labelAction?: ReactNode;
    maxDate?: Date;
    onFocus?: FocusEventHandler<HTMLInputElement>;
    onBlur?: FocusEventHandler<HTMLInputElement>;
    [key: string]: unknown;
  };

  export const DateTimeInput: ForwardRefExoticComponent<DateTimeInputProps & RefAttributes<HTMLInputElement>>;
}
