/** A file-name part from words: lower case letters, digits and hyphens only, so it can never carry a path or a header. */
export function slugOf(text: string, fallback: string, max = 60): string {
  const s = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s === '' ? fallback : s;
}

/** The moment a file was made, as `20261125-041300` in the business's time zone, so files sort by time and never collide by the day. */
export function fileStamp(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}${get('month')}${get('day')}-${get('hour')}${get('minute')}${get('second')}`;
}

/** `<business>_<report>_<timestamp>.<ext>`: the three things a person looks for in a folder of downloads. */
export function exportFileName(input: {
  business: string;
  report: string;
  now: Date;
  timeZone: string;
  extension: string;
}): string {
  return `${slugOf(input.business, 'business', 40)}_${slugOf(input.report, 'report', 50)}_${fileStamp(input.now, input.timeZone)}.${input.extension}`;
}
