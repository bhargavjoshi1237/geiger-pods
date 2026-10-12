"use client";

import { ChevronDown } from "lucide-react";
import { Button } from "@geiger/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@geiger/ui/dropdown-menu";

// Single-choice widget filter (mirrors geiger-events' overview FilterDropdown).
export default function FilterDropdown({ value, onValueChange, options, label }) {
  const current = options.find((option) => option.value === value);
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant="outline" size="sm" aria-label={label} className="border-border bg-surface-card text-foreground hover:bg-surface-subtle">
        <span className="max-w-30 truncate">{current?.label ?? "Select"}</span>
        <ChevronDown className="size-3.5 text-text-secondary" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto border-border bg-surface-subtle text-foreground">
      <DropdownMenuRadioGroup value={value} onValueChange={onValueChange}>
        {options.map((option) => <DropdownMenuRadioItem key={option.value} value={option.value} className="cursor-pointer text-xs focus:bg-surface-hover focus:text-foreground">{option.label}</DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
}
