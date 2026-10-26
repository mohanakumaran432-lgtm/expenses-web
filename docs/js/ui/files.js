// Getting a file from the person (a backup to restore) and handing a file to the person (a CSV, a PDF, a backup).
// Nothing is uploaded anywhere: a file goes into the iPhone's share sheet (where the person chooses Files, AirDrop, Mail...)
// or is downloaded to the device, and a chosen file is read right here.

/** Largest file the app will read into memory. */
export const MAX_FILE_BYTES = 200 * 1024 * 1024;

/**
 * Opens the system file chooser. Call it directly from a tap (a delay can make the browser refuse).
 * Resolves with the chosen File, or null if the person cancelled.
 */
export function pickFile({ accept = '' } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept) input.accept = accept;
    input.hidden = true;
    let settled = false;
    const finish = (file) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => finish(input.files && input.files[0] ? input.files[0] : null));
    input.addEventListener('cancel', () => finish(null));
    document.body.appendChild(input);
    input.click();
  });
}

/** Reads a chosen file as text. Throws an Error with `code` 'tooLarge' or 'unreadable'. */
export async function readFileText(file) {
  if (file.size > MAX_FILE_BYTES) {
    const error = new Error('That file is too large to open here.');
    error.code = 'tooLarge';
    throw error;
  }
  try {
    return await file.text();
  } catch {
    const error = new Error('That file could not be read.');
    error.code = 'unreadable';
    throw error;
  }
}

/** Makes the bytes of a text (UTF-8, optionally with a byte-order mark for spreadsheet programs). */
export function textBlob(text, mime) {
  return new Blob([text], { type: mime });
}

export function canShareFiles(file) {
  try {
    return Boolean(navigator.canShare && navigator.share && navigator.canShare({ files: [file] }));
  } catch {
    return false;
  }
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Gives the person a file. Uses the share sheet when the browser has one (that is where "Save to Files" is), else downloads it.
 * Call it directly from a tap. Resolves 'shared', 'downloaded' or 'cancelled'.
 */
export async function deliverFile({ filename, mime, blob }) {
  const file = new File([blob], filename, { type: mime });
  if (canShareFiles(file)) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    } catch (error) {
      if (error && error.name === 'AbortError') return 'cancelled';
      // Any other refusal: fall back to a plain download below.
    }
  }
  download(blob, filename);
  return 'downloaded';
}

/** File names such as "expenses-2026-10-20.csv". */
export function datedName(prefix, day, extension) {
  return `${prefix}-${day.toString()}.${extension}`;
}
