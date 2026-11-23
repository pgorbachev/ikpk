export const RELATION_MENU_STYLE_ID = 'program-picker-width';

export const RELATION_MENU_STYLE = `
[data-radix-popper-content-wrapper]:has([style*="--radix-combobox-trigger-width"]) {
  width: min(56rem, 94vw) !important;
  min-width: min(56rem, 94vw) !important;
}
[style*="--radix-combobox-trigger-width"] {
  width: min(56rem, 94vw) !important;
  max-width: 94vw !important;
}
[style*="--radix-combobox-trigger-width"] span {
  overflow: visible !important;
  text-overflow: unset !important;
  white-space: nowrap !important;
  max-width: none !important;
}
`;

type StyleHost = {
  getElementById(id: string): unknown;
  createElement(tag: string): { id: string; textContent: string };
  head: { appendChild(node: unknown): void };
};

/** Длинная подпись «институт — программа» не помещается в ширину поля. */
export function installRelationMenuWidth(host: StyleHost): void {
  if (host.getElementById(RELATION_MENU_STYLE_ID)) return;
  const style = host.createElement('style');
  style.id = RELATION_MENU_STYLE_ID;
  style.textContent = RELATION_MENU_STYLE;
  host.head.appendChild(style);
}
