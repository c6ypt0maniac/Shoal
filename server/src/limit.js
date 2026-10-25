// Runs fn over items, at most `limit` at a time. Results keep the items' order.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

// A whole-number limit from the environment, or the default.
export const envLimit = (name, fallback) => (Number.parseInt(process.env[name], 10) > 0 ? Number.parseInt(process.env[name], 10) : fallback);
