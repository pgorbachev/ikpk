import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { useEffect } from 'react';

type TiptapHtmlInputProps = {
  attribute: { type: string };
  disabled?: boolean;
  error?: string;
  hint?: string;
  label: string;
  name: string;
  onChange: (event: { target: { name: string; type: string; value: string } }) => void;
  required?: boolean;
  value?: string | null;
};

const toolbarButtonStyle = {
  background: 'var(--colors-neutral0)',
  border: '1px solid var(--colors-neutral200)',
  borderRadius: '4px',
  color: 'var(--colors-neutral800)',
  cursor: 'pointer',
  padding: '6px 9px',
} as const;

export default function TiptapHtmlInput({
  attribute,
  disabled = false,
  error,
  hint,
  label,
  name,
  onChange,
  required = false,
  value,
}: TiptapHtmlInputProps) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    content: value ?? '',
    editable: !disabled,
    onUpdate: ({ editor: updatedEditor }) => {
      onChange({
        target: {
          name,
          type: attribute.type,
          value: updatedEditor.getHTML(),
        },
      });
    },
    editorProps: {
      attributes: {
        'aria-label': label,
        style:
          'min-height: 180px; padding: 12px; outline: none; border: 1px solid var(--colors-neutral200); border-radius: 4px; background: var(--colors-neutral0);',
      },
    },
  });

  useEffect(() => {
    if (editor && value !== undefined && value !== editor.getHTML()) {
      editor.commands.setContent(value, { emitUpdate: false });
    }
  }, [editor, value]);

  if (!editor) {
    return null;
  }

  return (
    <div>
      <label htmlFor={name} style={{ display: 'block', fontWeight: 600, marginBottom: 8 }}>
        {label}
        {required ? ' *' : ''}
      </label>
      <div
        aria-label="Панель инструментов редактора"
        style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}
      >
        <button
          aria-label="Жирный"
          disabled={disabled}
          onClick={() => editor.chain().focus().toggleBold().run()}
          style={toolbarButtonStyle}
          type="button"
        >
          Ж
        </button>
        <button
          aria-label="Курсив"
          disabled={disabled}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          style={toolbarButtonStyle}
          type="button"
        >
          К
        </button>
        <button
          aria-label="Маркированный список"
          disabled={disabled}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          style={toolbarButtonStyle}
          type="button"
        >
          Список
        </button>
        <button
          aria-label="Вставить таблицу"
          disabled={disabled}
          onClick={() =>
            editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
          }
          style={toolbarButtonStyle}
          type="button"
        >
          Вставить таблицу
        </button>
        <button
          aria-label="Добавить строку таблицы"
          disabled={disabled || !editor.can().addRowAfter()}
          onClick={() => editor.chain().focus().addRowAfter().run()}
          style={toolbarButtonStyle}
          type="button"
        >
          Добавить строку
        </button>
        <button
          aria-label="Удалить таблицу"
          disabled={disabled || !editor.can().deleteTable()}
          onClick={() => editor.chain().focus().deleteTable().run()}
          style={toolbarButtonStyle}
          type="button"
        >
          Удалить таблицу
        </button>
      </div>
      <EditorContent editor={editor} id={name} />
      {hint ? <p style={{ color: 'var(--colors-neutral600)', marginTop: 8 }}>{hint}</p> : null}
      {error ? <p style={{ color: 'var(--colors-danger600)', marginTop: 8 }}>{error}</p> : null}
    </div>
  );
}
