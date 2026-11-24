import { defaultTreeAdapter as tree, parseFragment, serialize } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import type { siteContactPhones } from './site-contact-phones';

type Element = DefaultTreeAdapterMap['element'];
type Parent = DefaultTreeAdapterMap['parentNode'];
type ContactPhones = ReturnType<typeof siteContactPhones>;

function textOf(node: Parent): string {
  return node.childNodes.map((child) => {
    if (tree.isTextNode(child)) return child.value;
    return tree.isElementNode(child) ? textOf(child) : '';
  }).join('');
}

// Preserve layout and existing links. Only the identified contact cell or phone list
// item is rewritten, so other phone numbers in the same panel keep their owners.
function rewriteNumbers(node: Parent, phones: ContactPhones['center'][]) {
  let position = 0;
  const number = /\+7[\s(\d)-]*\d/g;
  function visit(parent: Parent) {
    for (const child of parent.childNodes) {
      if (tree.isTextNode(child)) {
        child.value = child.value.replace(number, (original) => phones[position++]?.text ?? original);
      } else if (tree.isElementNode(child)) {
        const href = child.attrs.find((attr) => attr.name === 'href');
        const start = position;
        const phoneLink = child.tagName === 'a' && href?.value.startsWith('tel:') ? href : undefined;
        if (phoneLink && phones[start]) phoneLink.value = phones[start].href;
        visit(child);
        if (phoneLink && position === start) position++;
      }
    }
  }
  visit(node);
}

export function withOrganizationContactPhones(html: string, phones: ContactPhones): string {
  const document = parseFragment(html);
  function visit(parent: Parent) {
    const elements = parent.childNodes.filter(tree.isElementNode);
    for (const [index, element] of elements.entries()) {
      if (element.tagName === 'tr') {
        const cells = element.childNodes.filter(tree.isElementNode).filter((cell) => ['td', 'th'].includes(cell.tagName));
        if (cells.length === 2 && textOf(cells[0]).trim() === 'Контактный телефон') {
          rewriteNumbers(cells[1], [phones.center, phones.manager]);
        }
      } else if (element.tagName === 'ul' && index > 0 && isCenterContactHeading(elements[index - 1])) {
        for (const item of element.childNodes.filter(tree.isElementNode)) {
          if (item.tagName === 'li' && /^\s*телефон\s*:/i.test(textOf(item))) rewriteNumbers(item, [phones.center]);
        }
      }
      visit(element);
    }
  }
  visit(document);
  return serialize(document);
}

function isCenterContactHeading(element: Element): boolean {
  return element.tagName === 'p' &&
    /Генеральный директор|Руководитель Учебного центра|Бухгалтерия/i.test(textOf(element));
}
