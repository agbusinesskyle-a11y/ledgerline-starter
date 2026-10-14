const day = 86400000;
export function timestampFromKey(key, prefix) {
  // Evidence stays untouched even if a caller supplies an evidence/ retention root.
  if (!key.startsWith(prefix) || /(^|\/)evidence\//.test(key)) return null;
  const match = key.slice(prefix.length).match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)(?:\.manifest\.json|-[a-f0-9]{16}\.(?:dump|globals\.sql)\.age)$/);
  return match && Number.isFinite(Date.parse(match[1])) ? match[1] : null;
}
function isoWeekStart(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return +d;
}
export function selectRetention(objects, prefix, now = new Date()) {
  const groups = new Map();
  const untouched = [];
  for (const object of objects) {
    const key = typeof object === 'string' ? object : object.Key;
    const ts = timestampFromKey(key, prefix);
    if (!ts) { untouched.push(key); continue; }
    if (!groups.has(ts)) groups.set(ts, []);
    groups.get(ts).push(key);
  }
  const keepTs = new Set(), days = new Set(), weeks = new Set(), months = new Set();
  const currentDay = Math.floor(+now / day), currentWeek = isoWeekStart(now);
  const currentMonth = now.getUTCFullYear() * 12 + now.getUTCMonth();
  for (const ts of [...groups.keys()].sort().reverse()) {
    const date = new Date(ts);
    if (+now - +date <= 2 * day) keepTs.add(ts);
    const keys = groups.get(ts);
    // A failed upload must not displace the newest complete restorable set.
    if (!keys.some(k => k.endsWith('.manifest.json')) || !keys.some(k => k.endsWith('.dump.age')) ||
        !keys.some(k => k.endsWith('.globals.sql.age'))) continue;
    const daily = Math.floor(+date / day), weekly = isoWeekStart(date);
    const monthly = date.getUTCFullYear() * 12 + date.getUTCMonth();
    if (currentDay - daily >= 0 && currentDay - daily < 14 && !days.has(daily)) { keepTs.add(ts); days.add(daily); }
    if (currentWeek - weekly >= 0 && (currentWeek - weekly) / (7 * day) < 8 && !weeks.has(weekly)) { keepTs.add(ts); weeks.add(weekly); }
    if (currentMonth - monthly >= 0 && currentMonth - monthly < 12 && !months.has(monthly)) { keepTs.add(ts); months.add(monthly); }
  }
  const keep = [], remove = [];
  for (const [ts, keys] of groups) (keepTs.has(ts) ? keep : remove).push(...keys);
  return { keep: keep.sort(), delete: remove.sort(), untouched: untouched.sort() };
}
