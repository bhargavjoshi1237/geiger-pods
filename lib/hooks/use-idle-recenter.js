"use client";

import { useCallback, useEffect, useRef } from "react";

const INTERACTION_EVENTS = ["wheel", "pointerdown", "touchstart", "keydown"];

const easeInOutCubic = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export function useIdleRecenter(
  activeKey,
  { delay = 10000, duration = 700, selector = "[data-active='true']" } = {},
) {
  const ref = useRef(null);
  const timer = useRef(null);
  const frame = useRef(0);
  const animating = useRef(false);

  const stopGlide = useCallback(() => {
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
    animating.current = false;
  }, []);

  const center = useCallback(() => {
    timer.current = null;
    const el = ref.current;
    const target = el?.querySelector(selector);
    if (!el || !target) return;

    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return;

    const elRect = el.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const delta =
      targetRect.top + targetRect.height / 2 - (elRect.top + elRect.height / 2);
    const from = el.scrollTop;
    const to = Math.max(0, Math.min(max, from + delta));
    const distance = to - from;

    stopGlide();

    const reduced = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    )?.matches;
    if (reduced || duration <= 0) {
      el.scrollTop = to;
      return;
    }

    animating.current = true;
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      el.scrollTop = from + distance * easeInOutCubic(t);
      if (t < 1) {
        frame.current = requestAnimationFrame(step);
        return;
      }
      frame.current = 0;
      animating.current = false;
    };
    frame.current = requestAnimationFrame(step);
  }, [selector, duration, stopGlide]);

  const arm = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(center, delay);
  }, [center, delay]);

  // Manual trigger for the same eased glide (e.g. after a filter reset
  // restores the full list). Re-arms the idle timer afterwards.
  const recenter = useCallback(() => {
    center();
    arm();
  }, [center, arm]);

  useEffect(() => {
    arm();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [activeKey, arm]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;

    const onScroll = () => {
      if (!animating.current) arm();
    };
    const onInteract = () => {
      if (animating.current) stopGlide();
      arm();
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    for (const type of INTERACTION_EVENTS) {
      el.addEventListener(type, onInteract, { passive: true });
    }
    return () => {
      el.removeEventListener("scroll", onScroll);
      for (const type of INTERACTION_EVENTS) {
        el.removeEventListener(type, onInteract);
      }
      stopGlide();
    };
  }, [arm, stopGlide]);

  return { ref, recenter };
}
