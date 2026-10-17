import type { ReactElement } from "react";
import type { Place } from "../lib/api.js";
import { navigate } from "../lib/route.js";
import { visible } from "../lib/text.js";

/** A file:line that opens the source lines around it in the target it was read from. */
export function PlaceLink({ place, targetId }: { place: Place; targetId: string }): ReactElement {
  const label = visible(`${place.file}${place.line === undefined ? "" : `:${place.line}`}`);
  return (
    <span className="place">
      {place.role && <span className="role">{place.role}</span>}
      {place.line === undefined ? (
        <code>{label}</code>
      ) : (
        <a
          href={`/targets/${targetId}/source?file=${encodeURIComponent(place.file)}&line=${place.line}`}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey) return;
            e.preventDefault();
            navigate(targetId, "source", { file: place.file, line: String(place.line) });
          }}
        >
          <code>{label}</code>
        </a>
      )}
    </span>
  );
}
