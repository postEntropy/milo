/**
 * What a list draws while it is being read: rows in the shape of the ones about to
 * arrive — the name and its meta on the left, the mark a row carries at its end —
 * so the wait shows the list it is about to become rather than a sentence sitting
 * in the middle of the space the list will fill.
 *
 * The sentence stays, readable to a screen reader: the shape is only a picture of
 * the wait, and it is the words that say what is being waited for.
 */
export function SkeletonList({ rows, label }: { rows: number; label: string }) {
  return <div className="skeleton-list">
    <span className="sr-only">{label}</span>
    {Array.from({ length: rows }, (_, index) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: the rows are placeholders in a fixed order — nothing inserts, removes or reorders among them
      <div className="skeleton-row" key={index} aria-hidden="true">
        <span className="skeleton-lines">
          <span className="skeleton-line skeleton-line-name" />
          <span className="skeleton-line skeleton-line-meta" />
        </span>
        <span className="skeleton-mark" />
      </div>
    ))}
  </div>
}
