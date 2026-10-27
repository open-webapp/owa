import { describe, expect, it } from 'vitest';
import { filterTagTree } from '../tagSearch.js';

const F = [
  {
    family: 'work', count: 5, hasChildren: true,
    children: [{ tag: 'work/urgent', count: 2 }, { tag: 'work/later', count: 3 }],
  },
  { family: 'home', count: 1, hasChildren: false, children: [] },
  { family: 'c++', count: 1, hasChildren: false, children: [] },
  { family: '__untagged__', count: 4, hasChildren: false, children: [] },
];

describe('filterTagTree', () => {
  it.each(['hom', 'home', 'HOME', '#home'])('matches home for %j', query => {
    expect(filterTagTree(F, query)).toEqual({
      nodes: [{ family: 'home', count: 1, hasChildren: false, children: [] }],
      active: true,
    });
  });

  it('retains only matching children without changing the family count', () => {
    expect(filterTagTree(F, 'urg')).toEqual({
      nodes: [{
        family: 'work', count: 5, hasChildren: true,
        children: [{ tag: 'work/urgent', count: 2 }],
      }],
      active: true,
    });
  });

  it.each(['work', ' work '])('retains all children for family query %j and excludes Untagged', query => {
    expect(filterTagTree(F, query)).toEqual({
      nodes: [{
        family: 'work', count: 5, hasChildren: true,
        children: [{ tag: 'work/urgent', count: 2 }, { tag: 'work/later', count: 3 }],
      }],
      active: true,
    });
  });

  it.each(['untagged', 'untag'])('matches the Untagged display label for %j', query => {
    expect(filterTagTree(F, query)).toEqual({
      nodes: [{ family: '__untagged__', count: 4, hasChildren: false, children: [] }],
      active: true,
    });
  });

  it.each(['', '   ', '#', ' # '])('leaves filtering inactive for %j', query => {
    expect(filterTagTree(F, query)).toEqual({ nodes: F, active: false });
  });

  it.each(['zzz', '(', '[', '.*'])('returns no matches for literal query %j without throwing', query => {
    expect(filterTagTree(F, query)).toEqual({ nodes: [], active: true });
  });

  it('matches plus signs literally', () => {
    expect(filterTagTree(F, 'c++')).toEqual({
      nodes: [{ family: 'c++', count: 1, hasChildren: false, children: [] }],
      active: true,
    });
  });

  it('preserves input order', () => {
    expect(filterTagTree(F, 'o')).toEqual({
      nodes: [
        {
          family: 'work', count: 5, hasChildren: true,
          children: [{ tag: 'work/urgent', count: 2 }, { tag: 'work/later', count: 3 }],
        },
        { family: 'home', count: 1, hasChildren: false, children: [] },
      ],
      active: true,
    });
  });

  it('does not mutate the input tree when filtering children', () => {
    const tree = structuredClone(F);
    const before = structuredClone(tree);

    expect(filterTagTree(tree, 'urg')).toEqual({
      nodes: [{
        family: 'work', count: 5, hasChildren: true,
        children: [{ tag: 'work/urgent', count: 2 }],
      }],
      active: true,
    });
    expect(tree).toEqual(before);
  });
});
