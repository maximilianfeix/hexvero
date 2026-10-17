import type { ReactElement } from "react";
import { visible } from "../lib/text.js";

/** A view whose data did not arrive: says what failed, announces it and offers to try again. */
export function LoadError({
  what,
  error,
  onRetry,
}: {
  what: string;
  error: Error;
  onRetry?: (() => void) | undefined;
}): ReactElement {
  return (
    <p className="empty" role="alert" style={{ color: "var(--alert)" }}>
      Could not load {what}: {visible(error.message)}{" "}
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          Retry
        </button>
      )}
    </p>
  );
}
