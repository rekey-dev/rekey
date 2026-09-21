/**
 * Read a response body without letting the sender decide how much memory it
 * costs.
 *
 * `res.json()` and `res.text()` buffer whatever the server sends. When the URL
 * is chosen by an operator (an OIDC issuer, an external billing endpoint) the
 * server on the other end is not ours, and the API process it would exhaust is
 * shared by every tenant.
 *
 * Call this with the request's abort signal still armed, so a server that
 * sends headers promptly and then trickles the body still hits the timeout.
 *
 * The read stops once `maxBytes` have arrived. `bytesRead` is what was actually
 * pulled off the wire (it can overshoot `maxBytes` by at most one chunk), so a
 * caller that must REFUSE an oversized body rather than truncate it reads with
 * a cap one byte above its limit and checks `bytesRead > limit`.
 */
export async function readCappedBody(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; bytesRead: number }> {
  if (!res.body) return { text: '', bytesRead: 0 };
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    total += value.byteLength;
  }
  void reader.cancel().catch(() => undefined);
  return { text: Buffer.concat(chunks).toString('utf8').slice(0, maxBytes), bytesRead: total };
}
