type EditLayout = {
  layout: unknown;
  metadatas?: Record<string, unknown>;
  components?: Record<string, { layout?: unknown; [key: string]: unknown }>;
  [key: string]: unknown;
};

type HookInput = { layout: EditLayout; query: Record<string, unknown> };

function withoutFields(rows: unknown, excluded: Set<string>): unknown {
  if (!Array.isArray(rows)) return rows;
  return rows.flatMap((item) => {
    if (Array.isArray(item)) return [withoutFields(item, excluded)];
    if (item && typeof item === 'object' && 'name' in item && typeof item.name === 'string') {
      return excluded.has(item.name) ? [] : [item];
    }
    return [item];
  });
}

export function hideUnneededEditFields<T extends HookInput>(input: T): T {
  const { layout } = input;
  const metadata = layout.metadatas ?? {};
  const excluded = new Set<string>();

  // These schema attributes uniquely identify their content types in the hook payload.
  if ('entry_status' in metadata && 'oldPrice' in metadata) {
    excluded.add('oldPrice');
    excluded.add('description');
  }
  if ('documents_owner_verified' in metadata && 'documents_state' in metadata) {
    excluded.add('documents_owner_verified');
  }
  excluded.add('student_document_form_url');

  const components = layout.components;
  const seo = components?.['shared.seo'];
  return {
    ...input,
    layout: {
      ...layout,
      ...(excluded.size ? { layout: withoutFields(layout.layout, excluded) } : {}),
      ...(seo?.layout ? {
        components: {
          ...components,
          'shared.seo': { ...seo, layout: withoutFields(seo.layout, new Set(['noindex'])) },
        },
      } : {}),
    },
  };
}
