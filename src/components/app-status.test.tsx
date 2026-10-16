import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppStatus } from "./app-status";

describe("AppStatus", () => {
  it("renders nothing when online", () => {
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    const { container } = render(<AppStatus />);
    expect(container.firstChild).toBeNull();
  });

  it("renders offline notice when offline event fires", () => {
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    render(<AppStatus />);
    expect(
      screen.getByText(/You appear to be offline. Your library and saved progress remain on this device/),
    ).toBeInTheDocument();
  });
});
