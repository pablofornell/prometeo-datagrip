/** Pure helpers of the Notifications tool window. */

const two = (n: number) => String(n).padStart(2, "0");

/** Timestamp text of an entry: `12:55` today, `Nov 5, 12:55` on another day (DataGrip shows the time only). */
export function timeText(time: number, now: number = Date.now()): string {
  const d = new Date(time);
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const n = new Date(now);
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return hm;
  const month = d.toLocaleString("en-US", { month: "short" });
  return `${month} ${d.getDate()}, ${hm}`;
}
