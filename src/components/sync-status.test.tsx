import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SyncStatusIndicator } from "./sync-status";

describe("SyncStatusIndicator", () => {
  it("renders status text and accessible status container", () => {
    render(<SyncStatusIndicator />);
    const statusContainer = screen.getByRole("status");
    expect(statusContainer).toBeInTheDocument();
  });

  it("can hide the action button if requested", () => {
    render(<SyncStatusIndicator showButton={false} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
