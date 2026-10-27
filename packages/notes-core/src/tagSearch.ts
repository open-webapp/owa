export interface TagNode {
  family: string;
  count: number;
  hasChildren: boolean;
  children: { tag: string; count: number }[];
}

export function filterTagTree(tree: TagNode[], query: string): { nodes: TagNode[]; active: boolean } {
  const trimmed = query.trim();
  const search = (trimmed.startsWith('#') ? trimmed.slice(1) : trimmed).toLowerCase();
  if (!search) return { nodes: tree, active: false };

  const nodes: TagNode[] = [];
  for (const node of tree) {
    const label = node.family === '__untagged__' ? 'Untagged' : node.family;
    if (label.toLowerCase().includes(search)) {
      nodes.push(node);
      continue;
    }

    const children = node.children.filter(child => child.tag.toLowerCase().includes(search));
    if (children.length) nodes.push({ ...node, children });
  }

  return { nodes, active: true };
}
