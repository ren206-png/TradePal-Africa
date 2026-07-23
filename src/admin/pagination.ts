export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export interface PaginationParams {
  take: number;
  skip: number;
}

export interface PaginationMeta {
  take: number;
  skip: number;
  hasMore: boolean;
}

/** Parses `?take=&skip=` query params, clamping `take` to [1, MAX_PAGE_SIZE] and `skip` to >= 0. Never throws — falls back to defaults on garbage input. */
export function parsePaginationParams(query: Record<string, unknown>): PaginationParams {
  const takeRaw = Number(query["take"]);
  const skipRaw = Number(query["skip"]);

  const take = Number.isFinite(takeRaw) && takeRaw > 0 ? Math.min(Math.floor(takeRaw), MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
  const skip = Number.isFinite(skipRaw) && skipRaw > 0 ? Math.floor(skipRaw) : 0;

  return { take, skip };
}

/**
 * Given rows fetched with `take: params.take + 1` (the "fetch one extra" trick), splits off the
 * lookahead row and reports whether more pages exist — without a separate COUNT(*) query.
 */
export function paginate<T>(rowsWithLookahead: T[], params: PaginationParams): { items: T[]; pagination: PaginationMeta } {
  const hasMore = rowsWithLookahead.length > params.take;
  const items = hasMore ? rowsWithLookahead.slice(0, params.take) : rowsWithLookahead;
  return { items, pagination: { take: params.take, skip: params.skip, hasMore } };
}
