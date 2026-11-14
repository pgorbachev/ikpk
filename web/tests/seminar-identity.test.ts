import { describe, expect, it } from 'vitest';
import { resolveSeminar } from '../src/lib/seminar-identity';

const seminars = [
  { documentId: 'a', slug: 'shared', duration: '10' },
  { documentId: 'b', slug: 'shared', duration: '20' },
  { documentId: 'c', slug: 'unique', duration: '30' },
];
describe('schedule seminar identity', () => {
  it('selects by documentId even when slugs collide', () => {
    expect(resolveSeminar(seminars, { documentId: 'b', slug: 'shared' })?.duration).toBe('20');
  });
  it('does not fall back when a documentId is unknown', () => {
    expect(resolveSeminar(seminars, { documentId: 'missing', slug: 'unique' })).toBeUndefined();
  });
  it('accepts a legacy slug only when unique', () => {
    expect(resolveSeminar(seminars, { slug: 'unique' })?.duration).toBe('30');
    expect(resolveSeminar(seminars, { slug: 'shared' })).toBeUndefined();
  });
  it('rejects an explicitly empty documentId rather than treating it as legacy', () => {
    expect(resolveSeminar(seminars, { documentId: '', slug: 'unique' })).toBeUndefined();
  });
  it('rejects repeated document IDs', () => {
    expect(resolveSeminar([...seminars, { documentId: 'b', slug: 'other', duration: '0' }], { documentId: 'b' })).toBeUndefined();
  });
});
