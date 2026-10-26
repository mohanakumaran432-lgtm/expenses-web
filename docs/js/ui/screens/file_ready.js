// A file that has been made and is waiting to be handed over. The iPhone's share sheet can only be opened from a tap,
// and making a backup (or checking its password) takes a moment, so the person taps once to make the file and once more to
// save or send it. Nothing is uploaded: the share sheet is where they choose Files, AirDrop, Mail and so on.

import { h } from '../dom.js';
import { button, group, notice, row, sheetContent } from '../components.js';
import { deliverFile } from '../files.js';

/** "48 KB", "1.2 MB". */
export function sizeText(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Shows the finished file and a button that saves or shares it.
 * Resolves 'shared' or 'downloaded' once it was handed over, or undefined when the sheet was closed without that.
 *
 * @param lead     one sentence for the green notice at the top
 * @param facts    extra rows: [{ title, value }]
 * @param notes    footnotes under the button
 */
export function presentFileReady(app, { title, filename, mime, blob, lead, facts = [], notes = [], buttonLabel = 'Save or share' }) {
  const { closed } = app.ui.present((_, __, handle) => {
    const sheet = sheetContent({ title, cancelLabel: 'Close', onCancel: () => handle.close(undefined) });
    const go = button(buttonLabel, {
      block: true,
      glyph: 'share',
      onClick: async () => {
        go.disabled = true;
        let outcome = 'cancelled';
        try {
          outcome = await deliverFile({ filename, mime, blob });
        } finally {
          go.disabled = false;
        }
        if (outcome === 'cancelled') return;
        handle.close(outcome);
      },
    });
    sheet.body.append(h('div', { class: 'stack-l' },
      notice({ kind: 'good', glyph: 'check', title: 'Ready', body: lead }),
      group([
        row({ title: 'File', value: filename }),
        row({ title: 'Size', value: sizeText(blob.size) }),
        ...facts.map((fact) => row({ title: fact.title, value: fact.value })),
      ]),
      go,
      ...notes.map((text) => h('p', { class: 't-foot footnote' }, text))));
    return { el: sheet.el, label: title };
  });
  return closed;
}
