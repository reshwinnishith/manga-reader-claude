import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const pathname = vi.hoisted(() => ({ value: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.value }));

import { AppNav, isActive } from "./app-nav";

describe("isActive", () => {
  it("matches sections exactly or by prefix, and only matches Home on /", () => {
    expect(isActive("/", "/")).toBe(true);
    expect(isActive("/", "/library")).toBe(false);
    expect(isActive("/library", "/library")).toBe(true);
    expect(isActive("/discover", "/discover/x")).toBe(true);
    expect(isActive("/library", "/librarian")).toBe(false);
  });
});

describe("<AppNav />", () => {
  it("links Home, Library and Discover and marks the current page", () => {
    pathname.value = "/library";
    render(<AppNav />);
    const links = screen.getAllByRole("link");
    expect(links.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      ["Home", "/"],
      ["Library", "/library"],
      ["Discover", "/discover"],
    ]);
    expect(screen.getByRole("link", { name: "Library" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
  });
});
