"use client";

import React, { useMemo } from "react";
import {
  DataTable,
  EditorSectionHeader,
  EmptyState,
  Field,
  InlineTitleInput,
  LoadingArea,
  RollingNumber as BaseRollingNumber,
  ScreenHeader,
  SearchInput,
  SectionCard,
  SegmentedTabs,
  SettingRow,
  SettingsList,
  StatusPill,
  Toolbar,
} from "@geiger/ui";
import { Card, CardContent } from "@geiger/ui/card";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { cn } from "@geiger/ui/lib/utils";

export {
  DataTable,
  EditorSectionHeader,
  EmptyState,
  Field,
  InlineTitleInput,
  LoadingArea,
  ScreenHeader,
  SearchInput,
  SectionCard,
  SegmentedTabs,
  SettingRow,
  SettingsList,
  StatusPill,
  Toolbar,
};

// Values at or above this absolute magnitude collapse to K/M/B on mobile.
// 10,000 = first 5-digit number, which is where the 2xl tabular figures start
// to overflow their half-width cells on ~360px screens.
export const COMPACT_THRESHOLD_DEFAULT = 10000;

// " $24,860 " -> { prefix: "$", numeric: 24860, suffix: "" }. Mirrors the parser
// inside @geiger/ui's RollingNumber so the compact form keeps its affixes.
function splitAffixes(value) {
  const str = String(value ?? "");
  const match = str.match(/^([^\d]*)([\d,]*\.?\d*)([^\d]*)$/);
  if (!match || match[2] === "") return null;
  const [, prefix, numPart, suffix] = match;
  const numeric = parseFloat(numPart.replace(/,/g, ""));
  if (!Number.isFinite(numeric)) return null;
  return { prefix, suffix, numeric, str };
}

function toCompactNumber(abs) {
  let scaled;
  let unit;
  if (abs >= 1e9) {
    scaled = abs / 1e9;
    unit = "B";
  } else if (abs >= 1e6) {
    scaled = abs / 1e6;
    unit = "M";
  } else {
    scaled = abs / 1e3;
    unit = "K";
  }
  const out =
    scaled >= 100
      ? String(Math.round(scaled))
      : String(Math.round(scaled * 10) / 10).replace(/\.0$/, "");
  return `${out}${unit}`;
}

// "$24,860" -> "$24.9K", "3,420,000" -> "3.4M". Pass-through for anything
// below `threshold`, non-numeric labels ("N/A"), and percentages (a compacted
// "12K%" reads worse than the full figure).
export function formatCompactValue(value, threshold = COMPACT_THRESHOLD_DEFAULT) {
  const parsed = splitAffixes(value);
  if (!parsed) return String(value ?? "");
  const { prefix, suffix, numeric, str } = parsed;
  if (/%/.test(suffix)) return str;
  if (Math.abs(numeric) < threshold) return str;
  return `${prefix}${toCompactNumber(Math.abs(numeric))}${suffix}`;
}

function resolveCompact(value, compactValue, threshold) {
  if (compactValue !== undefined) return String(compactValue);
  return formatCompactValue(value, threshold);
}

// Responsive RollingNumber: full figure on md+ screens, K/M form below that.
// Implemented as two BaseRollingNumbers toggled with Tailwind visibility
// (instead of a useIsMobile hook) so server and first client paint agree and
// there is no breakpoint-flash or re-roll on mount. The mobile copy keeps the
// full figure in `title` / `aria-label`.
export function RollingNumber({
  value,
  className,
  duration = 1100,
  compactOnMobile = true,
  compactThreshold = COMPACT_THRESHOLD_DEFAULT,
  compactValue,
}) {
  const compact = useMemo(
    () => resolveCompact(value, compactValue, compactThreshold),
    [value, compactValue, compactThreshold],
  );
  const fullStr = value === null || value === undefined ? "" : String(value);

  if (!compactOnMobile || !compact || compact === fullStr) {
    return <BaseRollingNumber value={value} className={className} duration={duration} />;
  }

  return (
    <>
      <span className="hidden min-w-0 md:inline-flex">
        <BaseRollingNumber value={value} className={className} duration={duration} />
      </span>
      <span className="inline-flex min-w-0 md:hidden" title={fullStr} aria-label={fullStr}>
        <BaseRollingNumber value={compact} className={className} duration={duration} />
      </span>
    </>
  );
}

export function StatGrid({
  stats,
  columns = 4,
  className,
  compactOnMobile = true,
  compactThreshold = COMPACT_THRESHOLD_DEFAULT,
}) {
  const colClass =
    {
      2: "sm:grid-cols-2",
      3: "sm:grid-cols-3",
      4: "grid-cols-2 lg:grid-cols-4",
      5: "grid-cols-2 lg:grid-cols-5",
    }[columns] || "grid-cols-2 lg:grid-cols-4";

  return (
    <div className={cn("grid gap-4", colClass, className)}>
      {stats.map((stat) => (
        <StatTile
          key={stat.label}
          {...stat}
          compactOnMobile={stat.compactOnMobile ?? compactOnMobile}
          compactThreshold={stat.compactThreshold ?? compactThreshold}
        />
      ))}
    </div>
  );
}

export function StatTile({
  label,
  value,
  delta,
  trend,
  hint,
  icon: Icon,
  compactOnMobile = true,
  compactThreshold = COMPACT_THRESHOLD_DEFAULT,
  compactValue,
}) {
  const trendClass =
    trend === "up"
      ? "text-emerald-600 dark:text-emerald-400"
      : trend === "down"
        ? "text-red-600 dark:text-red-400"
        : "text-text-secondary";

  return (
    <Card className="rounded-xl border-border bg-surface-subtle py-0 text-foreground capitalize">
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wider text-text-secondary">
            {label}
          </span>
          {Icon ? <Icon className="h-4 w-4 text-text-tertiary" /> : null}
        </div>
        <div className="mt-2 flex flex-col items-start gap-1 sm:flex-row sm:items-end sm:gap-2">
          <RollingNumber
            value={value}
            className="text-2xl font-bold leading-none text-foreground dark:text-white tabular-nums"
            compactOnMobile={compactOnMobile}
            compactThreshold={compactThreshold}
            compactValue={compactValue}
          />
          {delta ? (
            <span className={cn("text-xs font-medium sm:mb-0.5", trendClass)}>{delta}</span>
          ) : null}
        </div>
        {hint ? (
          <span className="mt-1.5 block text-[11px] text-text-tertiary">{hint}</span>
        ) : null}
      </CardContent>
    </Card>
  );
}

const STATS_BAR_COLS = {
  2: "grid-cols-2",
  3: "grid-cols-2 md:grid-cols-3",
  4: "grid-cols-2 md:grid-cols-4",
};

export function StatsBar({
  stats,
  columns = 4,
  className,
  compactOnMobile = true,
  compactThreshold = COMPACT_THRESHOLD_DEFAULT,
}) {
  const colCount = [2, 3, 4].includes(columns) ? columns : 4;
  const cols = STATS_BAR_COLS[colCount];

  return (
    <Card
      className={cn(
        "gap-0 overflow-hidden rounded-xl border-border bg-surface-subtle py-0 text-foreground",
        className,
      )}
    >
      <CardContent className="p-0">
        <div className={cn("grid", cols)}>
          {stats.map((stat, i) => {
            const up = stat.trend === "up";
            const TrendIcon = up ? ArrowUpRight : ArrowDownRight;
            return (
              <div
                key={stat.label}
                className={cn(
                  "p-4 border-border",
                  i % 2 !== 0 && "border-l",
                  i >= 2 && "border-t",
                  "md:border-l-0 md:border-t-0",
                  i % colCount !== 0 && "md:border-l",
                  i >= colCount && "md:border-t",
                )}
              >
                <span className="text-[11px] font-medium uppercase tracking-wider text-text-secondary">
                  {stat.label}
                </span>
                <div className="mt-1 flex flex-col items-start gap-1 sm:flex-row sm:items-end sm:gap-2">
                  <RollingNumber
                    value={stat.value}
                    className="text-2xl font-bold leading-none text-foreground dark:text-white"
                    compactOnMobile={stat.compactOnMobile ?? compactOnMobile}
                    compactThreshold={stat.compactThreshold ?? compactThreshold}
                    compactValue={stat.compactValue}
                  />
                  {stat.delta ? (
                    <span
                      className={cn(
                        "inline-flex items-center gap-0.5 text-xs font-medium sm:mb-0.5",
                        up ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400",
                      )}
                    >
                      <TrendIcon className="h-3 w-3" />
                      {stat.delta}
                    </span>
                  ) : null}
                </div>
                {stat.footer ? (
                  <span className="mt-1 block text-[11px] text-text-tertiary capitalize">
                    {stat.footer}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
