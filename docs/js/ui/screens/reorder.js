// Drag-to-reorder for a list of rows. Grab the handle at the end of a row, move up or down, let go.
// Works with a finger or a mouse, and with the up and down arrow keys while the handle has focus.
//
// While dragging, the other rows slide out of the way and nothing in the page is moved, so the finger never loses the row.
// The order is changed (and reported) once, when the row is dropped.

import { h } from '../dom.js';
import { icon } from '../icons.js';

/** The grip shown at the end of a row while its list is being reordered. */
export function dragHandle(label) {
  return h('button', {
    type: 'button',
    class: 'drag-handle',
    'aria-label': `Reorder ${label}. Drag, or use the up and down arrow keys.`,
  }, icon('drag'));
}

/**
 * Saves new orders one at a time. When the order changes again while the last one is still being saved (a held arrow key, two
 * quick drags), the newest order waits its turn and the ones in between are skipped, so the last thing the person did wins
 * and none of it is lost.
 *
 * @param save    (ids) => Promise, saves one order
 * @param onIdle  called once everything has been saved (draw the list from the stored data then)
 * Returns { submit(ids), busy }. While `busy`, the list on screen is already right and should not be redrawn.
 */
export function orderSaver(save, { onIdle = () => {} } = {}) {
  let running = false;
  let waiting = null;
  return {
    get busy() { return running; },
    submit(ids) {
      if (running) {
        waiting = ids;
        return;
      }
      running = true;
      (async () => {
        let next = ids;
        while (next) {
          waiting = null;
          try {
            await save(next);
          } catch { /* the save reports its own problems */ }
          next = waiting;
        }
        running = false;
        onIdle();
      })();
    },
  };
}

/**
 * A list is drawn again after every change, which would drop the keyboard focus from the handle that was just used. Call this
 * before drawing and the function it returns after, and the same row's handle gets the focus back.
 */
export function rememberHandleFocus(root) {
  const active = document.activeElement;
  const item = active && active.classList && active.classList.contains('drag-handle') && root.contains(active) ? active.closest('[data-id]') : null;
  const id = item ? item.dataset.id : null;
  return () => {
    if (id === null) return;
    for (const candidate of root.querySelectorAll('[data-id]')) {
      if (candidate.dataset.id !== id) continue;
      const handle = candidate.querySelector('.drag-handle');
      if (handle) handle.focus({ preventScroll: true });
      return;
    }
  };
}

/**
 * @param list      the element whose children marked with data-id are the rows
 * @param onChange  (ids) => void, called once after each move with the new order of ids
 * @returns a function that stops listening
 */
export function reorderable(list, { onChange }) {
  const rowsOf = () => Array.from(list.children).filter((el) => el.dataset && el.dataset.id);

  function onPointerDown(event) {
    const handle = event.target.closest ? event.target.closest('.drag-handle') : null;
    if (!handle || !list.contains(handle)) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const item = handle.closest('[data-id]');
    if (!item || item.parentElement !== list) return;
    event.preventDefault();

    const rows = rowsOf();
    const from = rows.indexOf(item);
    const scroller = list.closest('.page-scroll, .sheet-scroll');
    const scrollStart = scroller ? scroller.scrollTop : 0;
    const startY = event.clientY;
    // Where every row's middle is, measured in the scrolled content (so scrolling during the drag cannot confuse it).
    const centers = rows.map((el) => {
      const r = el.getBoundingClientRect();
      return r.top + r.height / 2 + scrollStart;
    });
    const height = item.getBoundingClientRect().height;
    let lastY = startY;
    let to = from;
    let timer = null;

    try { handle.setPointerCapture(event.pointerId); } catch { /* the drag still works without capture */ }
    list.classList.add('is-dragging');
    item.classList.add('dragging');

    const update = () => {
      const scrolled = (scroller ? scroller.scrollTop : 0) - scrollStart;
      const moved = lastY - startY + scrolled;
      item.style.transform = `translateY(${moved}px)`;
      const middle = centers[from] + moved;
      let up = 0;
      let down = 0;
      rows.forEach((other, index) => {
        if (index > from && middle > centers[index]) up += 1;
        if (index < from && middle < centers[index]) down += 1;
      });
      to = from + up - down;
      rows.forEach((other, index) => {
        if (other === item) return;
        let shift = 0;
        if (index > from && index <= to) shift = -height;
        if (index < from && index >= to) shift = height;
        other.style.transform = shift === 0 ? '' : `translateY(${shift}px)`;
      });
    };

    const autoScroll = () => {
      if (!scroller) return;
      const box = scroller.getBoundingClientRect();
      const edge = 70;
      let step = 0;
      if (lastY < box.top + edge) step = -Math.ceil((box.top + edge - lastY) / 6);
      else if (lastY > box.bottom - edge) step = Math.ceil((lastY - (box.bottom - edge)) / 6);
      if (step !== 0) {
        scroller.scrollTop += step;
        update();
      }
    };

    const onMove = (e) => {
      lastY = e.clientY;
      update();
    };
    const finish = (apply) => {
      clearInterval(timer);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onCancel);
      handle.removeEventListener('lostpointercapture', onCancel);
      try { handle.releasePointerCapture(event.pointerId); } catch { /* already released */ }
      list.classList.remove('is-dragging');
      item.classList.remove('dragging');
      for (const row of rows) row.style.transform = '';
      if (apply && to !== from) {
        const others = rows.filter((el) => el !== item);
        // Just before the row that now follows it, or right after the last row.
        list.insertBefore(item, others[to] || others[others.length - 1].nextSibling);
        onChange(rowsOf().map((el) => el.dataset.id));
        handle.focus({ preventScroll: true });
      }
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onCancel);
    handle.addEventListener('lostpointercapture', onCancel);
    timer = setInterval(autoScroll, 24);
    update();
  }

  function onKeyDown(event) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    const handle = event.target.closest ? event.target.closest('.drag-handle') : null;
    if (!handle || !list.contains(handle)) return;
    const item = handle.closest('[data-id]');
    if (!item || item.parentElement !== list) return;
    event.preventDefault();
    const rows = rowsOf();
    const index = rows.indexOf(item);
    if (event.key === 'ArrowUp' && index > 0) list.insertBefore(item, rows[index - 1]);
    else if (event.key === 'ArrowDown' && index < rows.length - 1) list.insertBefore(rows[index + 1], item);
    else return;
    handle.focus({ preventScroll: true });
    onChange(rowsOf().map((el) => el.dataset.id));
  }

  list.addEventListener('pointerdown', onPointerDown);
  list.addEventListener('keydown', onKeyDown);
  return () => {
    list.removeEventListener('pointerdown', onPointerDown);
    list.removeEventListener('keydown', onKeyDown);
  };
}
