export interface SessionCategoryLike {
  id: number;
  name: string;
  parent_id?: number | null;
}

export interface SessionCategoryAssignment {
  categoryId?: number | null;
}

export interface RecentSessionAssignment extends SessionCategoryAssignment {
  id: string;
  updatedAt?: number | null;
}

export interface VisibleSessionCategoryGroup<T> {
  key: string;
  label: string;
  sessions: T[];
  /** Nesting level in the category tree; 0 for top-level groups. */
  depth?: number;
  /** Group keys of every ancestor, outermost first. */
  ancestorKeys?: string[];
  /** Sessions in this category plus all of its sub-categories. */
  totalCount?: number;
}

export interface RecentSessionPartition<T> {
  group: VisibleSessionCategoryGroup<T>;
  remaining: T[];
}

const compareCategoryNames = (a: SessionCategoryLike, b: SessionCategoryLike) =>
  a.name.localeCompare(b.name) || a.id - b.id;

/** Children keyed by parent id; categories with a missing parent are treated as top level. */
function childrenByParent<C extends SessionCategoryLike>(categories: readonly C[]): Map<number | null, C[]> {
  const ids = new Set(categories.map((category) => category.id));
  const map = new Map<number | null, C[]>();
  for (const category of categories) {
    const parent = category.parent_id != null && ids.has(category.parent_id) && category.parent_id !== category.id
      ? category.parent_id
      : null;
    map.set(parent, [...(map.get(parent) || []), category]);
  }
  for (const list of map.values()) list.sort(compareCategoryNames);
  return map;
}

/** Full "Parent / Child" label for a category. */
export function categoryPathLabel(categories: readonly SessionCategoryLike[], id: number): string {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const names: string[] = [];
  const seen = new Set<number>();
  let current = byId.get(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    names.unshift(current.name);
    current = current.parent_id != null ? byId.get(current.parent_id) : undefined;
  }
  return names.join(" / ");
}

/** Ids of the category and everything nested under it. */
export function categorySubtreeIds(categories: readonly SessionCategoryLike[], id: number): Set<number> {
  const children = childrenByParent(categories);
  const ids = new Set<number>();
  const visit = (current: number) => {
    if (ids.has(current)) return;
    ids.add(current);
    for (const child of children.get(current) || []) visit(child.id);
  };
  visit(id);
  return ids;
}

/** Depth-first, flattened category tree; branches without any session are omitted. */
export function buildVisibleSessionCategoryGroups<T extends SessionCategoryAssignment>(
  categories: readonly SessionCategoryLike[],
  sessions: readonly T[],
  uncategorizedLabel: string,
): VisibleSessionCategoryGroup<T>[] {
  const knownCategoryIds = new Set(categories.map((category) => category.id));
  const children = childrenByParent(categories);
  const groups: VisibleSessionCategoryGroup<T>[] = [];

  const visit = (category: SessionCategoryLike, depth: number, ancestorKeys: string[]): number => {
    const key = `category-${category.id}`;
    const own = sessions.filter((session) => session.categoryId === category.id);
    const index = groups.length;
    groups.push({ key, label: category.name, sessions: own, depth, ancestorKeys, totalCount: own.length });
    let total = own.length;
    for (const child of children.get(category.id) || []) {
      total += visit(child, depth + 1, [...ancestorKeys, key]);
    }
    if (total === 0) groups.splice(index, 1);
    else groups[index].totalCount = total;
    return total;
  };
  for (const root of children.get(null) || []) visit(root, 0, []);

  const uncategorized = sessions.filter(
    (session) => session.categoryId == null || !knownCategoryIds.has(session.categoryId),
  );
  if (uncategorized.length > 0) {
    groups.push({
      key: "category-none",
      label: uncategorizedLabel,
      sessions: uncategorized,
      depth: 0,
      ancestorKeys: [],
      totalCount: uncategorized.length,
    });
  }
  return groups;
}

export function buildRecentSessionCategoryGroup<T extends RecentSessionAssignment>(
  sessions: readonly T[],
  limit: number,
  label: string,
): VisibleSessionCategoryGroup<T> {
  return partitionRecentSessions(sessions, limit, label).group;
}

export function partitionRecentSessions<T extends RecentSessionAssignment>(
  sessions: readonly T[],
  limit: number,
  label: string,
): RecentSessionPartition<T> {
  const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 10)));
  const recent = [...sessions]
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, safeLimit);
  return {
    group: {
      key: "recent",
      label,
      sessions: recent,
    },
    // “最近”是快捷入口，不从真实分类中移除对应会话。
    remaining: [...sessions],
  };
}
