/** Saves text as a file download in the browser. */
export function saveFile(text: string, filename: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Reads a chosen file as text (works in every browser, unlike relying on File.text()). */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsText(file);
  });
}

const KEY = 'oht-last-backup';

/** When this device last downloaded a backup (kept only in this browser). */
export function lastBackupDate(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function rememberBackup(date: string): void {
  try {
    localStorage.setItem(KEY, date);
  } catch {
    /* private mode: the reminder just will not remember */
  }
}

export function daysSince(date: string, today: string): number {
  return Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
}
