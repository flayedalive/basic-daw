// Running long DSP without freezing the page.
//
// The offline algorithms (stretch, pitch tracking, pitch shifting) are written
// as generators that yield their progress every so often. In Node a test just
// runs one to the end; in the app `runSliced` works it for a few milliseconds
// at a time and hands control back to the browser in between.

/** Run a generator to completion, synchronously. */
export function runToEnd(gen) {
  let step = gen.next();
  while (!step.done) step = gen.next();
  return step.value;
}

/**
 * Run a generator in slices of `budgetMs`. `onProgress` hears each yielded
 * value (0 → 1) and a final 1; `isCancelled` is asked between slices and ends
 * the run early, resolving null.
 */
export async function runSliced(gen, { budgetMs = 14, pause, onProgress, isCancelled } = {}) {
  const wait = pause ?? (() => new Promise((r) => setTimeout(r, 0)));
  let t0 = Date.now();
  let step = gen.next();
  while (!step.done) {
    if (Date.now() - t0 >= budgetMs) {
      onProgress?.(step.value);
      await wait();
      if (isCancelled?.()) return null;
      t0 = Date.now();
    }
    step = gen.next();
  }
  onProgress?.(1);
  return step.value;
}
