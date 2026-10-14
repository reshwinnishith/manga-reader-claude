"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType, SVGProps } from "react";
import { DiscoverIcon, HomeIcon, LibraryIcon } from "./icons";

export const NAV_ITEMS: { href: string; label: string; Icon: ComponentType<SVGProps<SVGSVGElement>> }[] = [
  { href: "/", label: "Home", Icon: HomeIcon },
  { href: "/library", label: "Library", Icon: LibraryIcon },
  { href: "/discover", label: "Discover", Icon: DiscoverIcon },
];

/** Section a path belongs to; series pages count as part of Library. */
export function isActive(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * One nav, two presentations: a bottom tab bar on phones and a left rail on
 * larger screens (switched purely with CSS, so there is a single set of links).
 */
export function AppNav() {
  const pathname = usePathname();
  return (
    <nav className="nav" aria-label="Main">
      <div className="nav__brand" aria-hidden="true">Manga<span>Reader</span></div>
      <ul className="nav__list">
        {NAV_ITEMS.map(({ href, label, Icon }) => {
          const active = isActive(href, pathname);
          return (
            <li key={href}>
              <Link href={href} className="nav__link" aria-current={active ? "page" : undefined}>
                <Icon />
                <span>{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
