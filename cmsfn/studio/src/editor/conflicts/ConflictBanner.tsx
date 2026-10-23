/**
 * REV_CONFLICT: deterministic options — refresh, attempt re-apply.
 */

export interface ConflictBannerProps {
  onRefresh: () => void;
  onReApply: () => void;
}

export function ConflictBanner({ onRefresh, onReApply }: ConflictBannerProps) {
  return (
    <div data-conflict-banner role="alert">
      <p data-conflict-message>Document was changed by someone else. Refresh to see changes, or re-apply your edits.</p>
      <button type="button" data-conflict-refresh onClick={onRefresh}>
        Refresh
      </button>
      <button type="button" data-conflict-reapply onClick={onReApply}>
        Re-apply my changes
      </button>
    </div>
  );
}
