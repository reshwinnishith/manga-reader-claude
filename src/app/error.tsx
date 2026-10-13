"use client";

import { ErrorState } from "@/components/ui";

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="fullpage">
      <ErrorState
        title="Something went wrong"
        body="An unexpected error occurred. Your reading progress is safe."
        action={
          <button type="button" className="btn btn--primary" onClick={reset}>
            Try again
          </button>
        }
      />
    </div>
  );
}
