import type { PaginationMeta } from "../lib/types";

interface PagerProps {
  pagination: PaginationMeta;
  onPrev: () => void;
  onNext: () => void;
}

export function Pager({ pagination, onPrev, onNext }: PagerProps) {
  const page = Math.floor(pagination.skip / pagination.take) + 1;
  return (
    <div className="pager">
      <button type="button" onClick={onPrev} disabled={pagination.skip === 0}>
        Previous
      </button>
      <span>Page {page}</span>
      <button type="button" onClick={onNext} disabled={!pagination.hasMore}>
        Next
      </button>
    </div>
  );
}
