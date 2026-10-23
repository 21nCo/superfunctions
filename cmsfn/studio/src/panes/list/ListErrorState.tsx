/**
 * Deterministic error state for list pane: message + retry.
 */

export interface ListErrorStateProps {
  code: string;
  message: string;
  onRetry: () => void;
}

export function ListErrorState({ code, message, onRetry }: ListErrorStateProps) {
  return (
    <div data-list-error role="alert" data-error-code={code}>
      <p data-list-error-message>{message}</p>
      <button type="button" onClick={onRetry} data-list-error-retry>
        Retry
      </button>
    </div>
  );
}
