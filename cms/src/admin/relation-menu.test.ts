import assert from 'node:assert/strict';
import test from 'node:test';
import { installRelationMenuWidth, RELATION_MENU_STYLE, RELATION_MENU_STYLE_ID } from './relation-menu.ts';

test('широкое меню связи ставится в документ один раз', () => {
  const nodes: { id: string; textContent: string }[] = [];
  const host = {
    getElementById(id: string) {
      return nodes.find((node) => node.id === id) ?? null;
    },
    createElement() {
      return { id: '', textContent: '' };
    },
    head: { appendChild(node: { id: string; textContent: string }) { nodes.push(node); } },
  };
  installRelationMenuWidth(host);
  installRelationMenuWidth(host);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].id, RELATION_MENU_STYLE_ID);
  assert.match(nodes[0].textContent, /min\(56rem, 94vw\)/);
  assert.equal(nodes[0].textContent, RELATION_MENU_STYLE);
});
