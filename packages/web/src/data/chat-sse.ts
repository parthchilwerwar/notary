// Incremental text/event-stream parser for SSE over a POST (EventSource can't POST). Feed it the
// decoded chunks as they arrive, in any split; it returns every complete message. Per the SSE spec:
// messages end at a blank line, `data:` lines join with "\n", one leading space after the colon is
// dropped, lines starting with ":" are comments, CRLF / CR / LF all end a line.

export type SseMessage = { event?: string; data: string };

export class SseParser {
  private buffer = "";
  private data: string[] = [];
  private event: string | undefined;

  /** Add a chunk; returns the messages it completed. */
  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const out: SseMessage[] = [];
    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.buffer);
      if (!m) break;
      // A lone "\r" at the very end may be the first half of "\r\n": wait for the next chunk.
      if (m[0] === "\r" && m.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, m.index);
      this.buffer = this.buffer.slice(m.index + m[0].length);
      const message = this.line(line);
      if (message) out.push(message);
    }
    return out;
  }

  /** End of stream: a final message without its trailing blank line is still delivered. */
  end(): SseMessage[] {
    const out: SseMessage[] = [];
    if (this.buffer) {
      const message = this.line(this.buffer);
      this.buffer = "";
      if (message) out.push(message);
    }
    const last = this.dispatch();
    if (last) out.push(last);
    return out;
  }

  private line(line: string): SseMessage | undefined {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    return undefined;
  }

  private dispatch(): SseMessage | undefined {
    if (!this.data.length) {
      this.event = undefined;
      return undefined;
    }
    const message: SseMessage = { data: this.data.join("\n"), ...(this.event ? { event: this.event } : {}) };
    this.data = [];
    this.event = undefined;
    return message;
  }
}
