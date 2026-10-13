"use client";

import React, { useMemo, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@geiger/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@geiger/ui/dropdown-menu";
import { cn } from "@geiger/ui/lib/utils";

// One pagination footer for every list in the app: page size on the left,
// page controls on the right. Kept self-contained so it can move to @geiger/ui
// once the shape settles.

export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

const ELLIPSIS = "…";

// Page 1 and the last page always show; the current page keeps a sibling either
// side. Ellipses fill the gaps so the control's width barely moves as you page.
function pageWindow(page, totalPages, span = 3) {
  if (totalPages <= span + 2) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const half = Math.floor(span / 2);
  let start = Math.max(2, page - half);
  let end = start + span - 1;
  if (end >= totalPages) {
    end = totalPages - 1;
    start = end - span + 1;
  }
  const out = [1];
  if (start > 2) out.push(`${ELLIPSIS}-start`);
  for (let i = start; i <= end; i += 1) out.push(i);
  if (end < totalPages - 1) out.push(`${ELLIPSIS}-end`);
  out.push(totalPages);
  return out;
}

// Client-side paging over an in-memory array. `resetKey` is any string that
// describes the active filters — change it and the user lands back on page 1.
export function usePagination(items, { pageSize: initialSize = 25, resetKey } = {}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialSize);

  const total = items?.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  // Clamp on read instead of syncing state, so a list that shrinks under the
  // user never renders an empty page.
  const safePage = Math.min(Math.max(1, page), totalPages);

  // Adjusting state during render — React's recommended answer to "reset when a
  // prop changes", and cheaper than an effect that fires after a wasted paint.
  const [lastResetKey, setLastResetKey] = useState(resetKey);
  if (resetKey !== lastResetKey) {
    setLastResetKey(resetKey);
    setPage(1);
  }

  const onPageSizeChange = (size) => {
    const next = Number(size) || initialSize;
    // Keep the first visible row on screen instead of snapping back to page 1.
    const anchor = (safePage - 1) * pageSize;
    setPageSize(next);
    setPage(Math.floor(anchor / next) + 1);
  };

  const pageItems = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return (items ?? []).slice(start, start + pageSize);
  }, [items, safePage, pageSize]);

  return {
    page: safePage,
    pageSize,
    total,
    totalPages,
    pageItems,
    onPageChange: setPage,
    onPageSizeChange,
  };
}

function PageSizeSelect({ pageSize, options, onPageSizeChange }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label="Rows Per Page"
          className="rounded-lg border-border bg-surface-card px-2.5 text-xs font-medium text-foreground hover:bg-surface-subtle"
        >
          <span className="tabular-nums">{pageSize}</span>
          <ChevronDown className="ml-0.5 h-3.5 w-3.5 text-text-secondary" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="min-w-[7rem] border-border bg-surface-subtle text-foreground"
      >
        <DropdownMenuRadioGroup
          value={String(pageSize)}
          onValueChange={(v) => onPageSizeChange(Number(v))}
        >
          {options.map((size) => (
            <DropdownMenuRadioItem
              key={size}
              value={String(size)}
              className="cursor-pointer text-xs focus:bg-surface-hover focus:text-foreground"
            >
              {size} Per Page
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ListPagination({
  page,
  pageSize,
  total,
  totalPages,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = PAGE_SIZE_OPTIONS,
  itemLabel = "items",
  className,
}) {
  if (!total) return null;

  const pages = Math.max(1, totalPages ?? Math.ceil(total / pageSize));
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const slots = pageWindow(page, pages);

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 px-1",
        className,
      )}
    >
      <div className="flex items-center gap-2.5 text-xs text-text-secondary">
        <PageSizeSelect
          pageSize={pageSize}
          options={pageSizeOptions}
          onPageSizeChange={onPageSizeChange}
        />
        <span>Per Page</span>
        <span aria-hidden className="text-text-tertiary">
          ·
        </span>
        <span className="tabular-nums">
          <span className="text-foreground">
            {from.toLocaleString("en-US")}–{to.toLocaleString("en-US")}
          </span>{" "}
          of {total.toLocaleString("en-US")} {itemLabel}
        </span>
      </div>

      <nav aria-label="Pagination" className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="text-text-secondary hover:bg-surface-active hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>

        <span className="px-2 text-xs text-text-secondary tabular-nums sm:hidden">
          Page {page} of {pages}
        </span>

        <div className="hidden items-center gap-1 sm:flex">
          {slots.map((slot) =>
            typeof slot === "number" ? (
              <Button
                key={slot}
                variant="ghost"
                size="icon-sm"
                aria-label={`Page ${slot}`}
                aria-current={slot === page ? "page" : undefined}
                onClick={() => onPageChange(slot)}
                className={cn(
                  "text-xs tabular-nums",
                  slot === page
                    ? "bg-surface-strong text-foreground hover:bg-surface-strong"
                    : "text-text-secondary hover:bg-surface-active hover:text-foreground",
                )}
              >
                {slot}
              </Button>
            ) : (
              <span
                key={slot}
                aria-hidden
                className="w-5 text-center text-xs text-text-tertiary"
              >
                {ELLIPSIS}
              </span>
            ),
          )}
        </div>

        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Next page"
          disabled={page >= pages}
          onClick={() => onPageChange(page + 1)}
          className="text-text-secondary hover:bg-surface-active hover:text-foreground"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </nav>
    </div>
  );
}

export default ListPagination;
