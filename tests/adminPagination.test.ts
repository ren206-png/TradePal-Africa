import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, paginate, parsePaginationParams } from "../src/admin/pagination.js";

describe("parsePaginationParams", () => {
  it("defaults take/skip when the query is empty", () => {
    expect(parsePaginationParams({})).toEqual({ take: DEFAULT_PAGE_SIZE, skip: 0 });
  });

  it("parses valid numeric strings", () => {
    expect(parsePaginationParams({ take: "10", skip: "20" })).toEqual({ take: 10, skip: 20 });
  });

  it("clamps take to MAX_PAGE_SIZE", () => {
    expect(parsePaginationParams({ take: "99999" })).toEqual({ take: MAX_PAGE_SIZE, skip: 0 });
  });

  it("falls back to defaults for garbage/negative input rather than throwing", () => {
    expect(parsePaginationParams({ take: "not-a-number", skip: "-5" })).toEqual({ take: DEFAULT_PAGE_SIZE, skip: 0 });
  });
});

describe("paginate", () => {
  it("reports hasMore=false when fewer rows than take+1 were fetched", () => {
    const result = paginate([1, 2, 3], { take: 10, skip: 0 });
    expect(result.items).toEqual([1, 2, 3]);
    expect(result.pagination).toEqual({ take: 10, skip: 0, hasMore: false });
  });

  it("slices off the lookahead row and reports hasMore=true when there's an extra row", () => {
    const result = paginate([1, 2, 3], { take: 2, skip: 0 });
    expect(result.items).toEqual([1, 2]);
    expect(result.pagination).toEqual({ take: 2, skip: 0, hasMore: true });
  });
});
