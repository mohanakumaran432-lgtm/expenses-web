// Typing in a text box needs the whole screen. In a sheet with an on-screen number keypad at its foot, the keypad steps aside while a
// text box has the focus (the iPhone keyboard takes its place) and comes back when the typing is over.
//
// An iPhone does not end the typing by itself: the Return key and a tap on blank space both leave the box focused, so the keypad
// would never come back. Both end the typing here. A drag (scrolling to the next box) does not.

const TYPING_BOX = 'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=range]), textarea';
const ONE_LINE_BOX = 'input[type=text], input[type=search], input:not([type])';
const TAPPABLE = 'input, textarea, select, button, a, label, summary, [role=switch], [role=button], [tabindex]';
const TAP_SLOP_PX = 10;

const isTypingBox = (element) => Boolean(element && element.matches && element.matches(TYPING_BOX));

/** Call once with the element of a sheet that has a keypad in its footer. */
export function keypadYieldsToKeyboard(sheetEl) {
  sheetEl.addEventListener('focusin', (event) => {
    if (isTypingBox(event.target)) sheetEl.classList.add('typing');
  });
  sheetEl.addEventListener('focusout', (event) => {
    // Moving from one text box to the next keeps the keypad away, so the sheet does not jump in between.
    if (isTypingBox(event.relatedTarget)) return;
    sheetEl.classList.remove('typing');
  });

  // Return ends the typing in a one-line box (a box that handled Return itself, such as adding a tag, is left alone).
  sheetEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.defaultPrevented || event.isComposing) return;
    const box = event.target;
    if (box && box.matches && box.matches(ONE_LINE_BOX)) {
      event.preventDefault();
      box.blur();
    }
  });

  // A tap on blank space ends it too.
  let down = null;
  sheetEl.addEventListener('pointerdown', (event) => {
    down = { x: event.clientX, y: event.clientY, target: event.target };
  });
  sheetEl.addEventListener('pointercancel', () => { down = null; });
  sheetEl.addEventListener('pointerup', (event) => {
    const start = down;
    down = null;
    if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > TAP_SLOP_PX) return;
    const active = document.activeElement;
    if (!isTypingBox(active) || !sheetEl.contains(active)) return;
    // Something that can be tapped for its own sake does its own job. (The frame around the sheet takes the focus when the sheet
    // opens, so it carries a tabindex; only what is inside the sheet itself counts.)
    const tapped = start.target && start.target.closest ? start.target.closest(TAPPABLE) : null;
    if (tapped && sheetEl.contains(tapped) && tapped !== sheetEl) return;
    active.blur();
  });
}
