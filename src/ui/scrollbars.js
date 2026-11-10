// Scrollbars for the arrangement. The lanes are one canvas, so the browser has
// nothing to scroll: these bars read and write `view.scrollX/scrollY` like the
// wheel and pan gestures do, and redraw on the same events the canvas does.
//
// Horizontal extent is the project plus half a screen of room past its end
// (more if you have already scrolled further), so there is always somewhere to
// drop the next clip without the thumb filling the bar.

import { el, clamp } from "../util.js";
import { bus, changed, state } from "../state.js";
import { view, contentHeight, viewportHeight, viewportWidth, scrollTracksTo } from "./timeline.js";

const MIN_THUMB = 28;

export function initScrollbars() {
  const wrap = document.querySelector(".lane-wrap");
  const hThumb = el("div.sb-thumb");
  const vThumb = el("div.sb-thumb");
  const hBar = el("div.sb.sb-h", { title: "Drag to scroll · click to page" }, hThumb);
  const vBar = el("div.sb.sb-v", { title: "Drag to scroll · click to page" }, vThumb);
  wrap.append(hBar, vBar);

  /** Seconds the horizontal bar spans. */
  const extentSec = () => {
    const viewSec = viewportWidth() / view.pxPerSec;
    let end = 0;
    for (const c of state.project.clips) end = Math.max(end, c.start + c.duration);
    const loop = state.project.loop;
    if (loop.enabled) end = Math.max(end, loop.end);
    for (const m of state.project.markers ?? []) end = Math.max(end, m.time);
    end = Math.max(end, state.playhead);
    return Math.max(end + viewSec * 0.5, view.scrollX + viewSec, viewSec);
  };

  // Geometry shared by paint and drag: track length, thumb length, scroll range.
  const hGeom = () => {
    const track = hBar.clientWidth;
    const viewSec = viewportWidth() / view.pxPerSec;
    const extent = extentSec();
    const thumb = clamp((viewSec / extent) * track, MIN_THUMB, track);
    return { track, thumb, range: Math.max(0, extent - viewSec), viewSec };
  };
  const vGeom = () => {
    const track = vBar.clientHeight;
    const vh = viewportHeight();
    const content = contentHeight();
    const thumb = clamp((vh / Math.max(content, 1)) * track, MIN_THUMB, track);
    return { track, thumb, range: Math.max(0, content - vh), vh };
  };

  let queued = false;
  const paint = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const v = vGeom();
      const showV = v.range > 0;
      vBar.hidden = !showV;
      hBar.style.right = showV ? "10px" : "0";
      const h = hGeom();
      hThumb.style.width = `${h.thumb}px`;
      hThumb.style.transform = `translateX(${h.range ? (view.scrollX / h.range) * (h.track - h.thumb) : 0}px)`;
      if (showV) {
        vThumb.style.height = `${v.thumb}px`;
        vThumb.style.transform = `translateY(${(view.scrollY / v.range) * (v.track - v.thumb)}px)`;
      }
    });
  };

  // Drag a thumb: pixels on the bar map linearly onto the scroll range.
  const dragThumb = (thumb, axis) => {
    thumb.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      thumb.setPointerCapture(e.pointerId);
      thumb.classList.add("active");
      const g0 = axis === "x" ? hGeom() : vGeom();
      const start = axis === "x" ? view.scrollX : view.scrollY;
      const p0 = axis === "x" ? e.clientX : e.clientY;
      const move = (ev) => {
        const per = g0.range / Math.max(1, g0.track - g0.thumb);
        const d = ((axis === "x" ? ev.clientX : ev.clientY) - p0) * per;
        if (axis === "x") {
          view.scrollX = Math.max(0, start + d);
          changed("view", false);
        } else scrollTracksTo(start + d);
      };
      const up = () => {
        thumb.classList.remove("active");
        thumb.removeEventListener("pointermove", move);
        thumb.removeEventListener("pointerup", up);
        thumb.removeEventListener("pointercancel", up);
      };
      thumb.addEventListener("pointermove", move);
      thumb.addEventListener("pointerup", up);
      thumb.addEventListener("pointercancel", up);
    });
  };
  dragThumb(hThumb, "x");
  dragThumb(vThumb, "y");

  // Click the bar itself: page one screen toward the click.
  hBar.addEventListener("pointerdown", (e) => {
    if (e.target !== hBar) return;
    const r = hThumb.getBoundingClientRect();
    const dir = e.clientX < r.left ? -1 : 1;
    view.scrollX = Math.max(0, view.scrollX + dir * hGeom().viewSec * 0.9);
    changed("view", false);
  });
  vBar.addEventListener("pointerdown", (e) => {
    if (e.target !== vBar) return;
    const r = vThumb.getBoundingClientRect();
    const dir = e.clientY < r.top ? -1 : 1;
    scrollTracksTo(view.scrollY + dir * viewportHeight() * 0.9);
  });
  // Wheel over a bar scrolls along it.
  hBar.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      view.scrollX = Math.max(0, view.scrollX + (e.deltaY || e.deltaX) / view.pxPerSec);
      changed("view", false);
    },
    { passive: false },
  );

  for (const evt of ["view", "tracks", "clips", "project", "loop"]) bus.on(evt, paint);
  new ResizeObserver(paint).observe(wrap);
  paint();
}
