import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { QuickScrubber } from "./quick-scrubber";

describe("QuickScrubber", () => {
  it("renders slider semantics and respects visible prop", () => {
    const onPageChange = vi.fn();
    const { rerender } = render(
      <QuickScrubber pageCount={40} currentPage={0} visible={true} onPageChange={onPageChange} />,
    );

    const slider = screen.getByRole("slider", { name: "Quick page scrubber" });
    expect(slider).toBeInTheDocument();
    expect(slider).toHaveAttribute("aria-valuemin", "1");
    expect(slider).toHaveAttribute("aria-valuemax", "40");
    expect(slider).toHaveAttribute("aria-valuenow", "1");
    expect(slider).toHaveAttribute("aria-valuetext", "Page 1 of 40");

    rerender(<QuickScrubber pageCount={40} currentPage={0} visible={false} onPageChange={onPageChange} />);
    const aside = screen.getByLabelText("Page scrubber");
    expect(aside).toHaveAttribute("aria-hidden", "true");
    expect(slider).toHaveAttribute("tabindex", "-1");
  });

  it("handles keyboard navigation: ArrowDown, ArrowUp, Home, End", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(<QuickScrubber pageCount={50} currentPage={10} visible={true} onPageChange={onPageChange} />);

    const slider = screen.getByRole("slider", { name: "Quick page scrubber" });
    slider.focus();

    await user.keyboard("{ArrowDown}");
    expect(onPageChange).toHaveBeenCalledWith(11);

    await user.keyboard("{ArrowUp}");
    expect(onPageChange).toHaveBeenCalledWith(9);

    await user.keyboard("{Home}");
    expect(onPageChange).toHaveBeenCalledWith(0);

    await user.keyboard("{End}");
    expect(onPageChange).toHaveBeenCalledWith(49);
  });

  it("supports dragging to jump with live page bubble indicator for 50+ page chapters", () => {
    const onPageChange = vi.fn();
    const pageCount = 60;
    render(<QuickScrubber pageCount={pageCount} currentPage={0} visible={true} onPageChange={onPageChange} />);

    const slider = screen.getByRole("slider", { name: "Quick page scrubber" });

    // Mock bounding rect: top 100, height 400
    vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({
      top: 100,
      bottom: 500,
      height: 400,
      left: 10,
      right: 54,
      width: 44,
      x: 10,
      y: 100,
      toJSON: () => {},
    });

    // PointerDown at top (clientY = 100) -> page 0
    fireEvent.pointerDown(slider, { clientY: 100, pointerId: 1 });
    expect(onPageChange).toHaveBeenLastCalledWith(0);
    expect(screen.getByRole("status")).toHaveTextContent("Page 1 / 60");

    // PointerMove to middle (clientY = 300) -> 50% through 59 pages -> page 30
    fireEvent.pointerMove(slider, { clientY: 300, pointerId: 1 });
    expect(onPageChange).toHaveBeenLastCalledWith(30);
    expect(screen.getByRole("status")).toHaveTextContent("Page 31 / 60");

    // PointerMove to bottom (clientY = 500) -> page 59 (last page)
    fireEvent.pointerMove(slider, { clientY: 500, pointerId: 1 });
    expect(onPageChange).toHaveBeenLastCalledWith(59);
    expect(screen.getByRole("status")).toHaveTextContent("Page 60 / 60");

    // PointerUp ends dragging and dismisses live status bubble
    fireEvent.pointerUp(slider, { clientY: 500, pointerId: 1 });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
