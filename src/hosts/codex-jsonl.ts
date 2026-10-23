const lineLimit = 256 * 1024;

export class CodexJsonlReader {
  readonly #onLine: (line: string) => void;
  #lineBuffer = '';
  #lineBufferBytes = 0;
  #pendingCarriageReturn = false;
  #discardingLine = false;
  #oversizedLineCount = 0;

  constructor(onLine: (line: string) => void) {
    this.#onLine = onLine;
  }

  get oversizedLineCount(): number {
    return this.#oversizedLineCount;
  }

  consume(chunk: string): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf('\n', offset);
      const hasNewline = newline !== -1;
      const end = hasNewline ? newline : chunk.length;

      if (this.#discardingLine) {
        if (!hasNewline) return;
        this.recordOversizedLine();
        this.#discardingLine = false;
        offset = newline + 1;
        continue;
      }

      const hasTrailingCarriageReturn =
        end > offset && chunk.charCodeAt(end - 1) === 13;
      const segmentEnd =
        hasTrailingCarriageReturn && hasNewline ? end - 1 : end;
      const holdCarriageReturn = hasTrailingCarriageReturn && !hasNewline;

      if (this.#pendingCarriageReturn) {
        if (segmentEnd === offset && hasNewline && !hasTrailingCarriageReturn) {
          this.#pendingCarriageReturn = false;
          this.emitLine();
          offset = newline + 1;
          continue;
        }
        this.#pendingCarriageReturn = false;
        if (!this.append('\r')) {
          this.overflow(hasNewline);
          if (!hasNewline) return;
          offset = newline + 1;
          continue;
        }
      }

      const segmentLength = segmentEnd - offset;
      if (segmentLength > lineLimit - this.#lineBufferBytes) {
        this.overflow(hasNewline);
        if (!hasNewline) return;
        offset = newline + 1;
        continue;
      }

      if (segmentLength > 0) {
        const segment = chunk.slice(offset, segmentEnd);
        if (!this.append(segment)) {
          this.overflow(hasNewline);
          if (!hasNewline) return;
          offset = newline + 1;
          continue;
        }
      }

      this.#pendingCarriageReturn = holdCarriageReturn;
      if (!hasNewline) return;
      this.emitLine();
      offset = newline + 1;
    }
  }

  finish(): void {
    if (this.#discardingLine) {
      this.recordOversizedLine();
      this.#discardingLine = false;
      this.clearLine();
      return;
    }

    if (this.#pendingCarriageReturn) {
      this.#pendingCarriageReturn = false;
      if (!this.append('\r')) {
        this.recordOversizedLine();
        this.clearLine();
        return;
      }
    }

    if (this.#lineBufferBytes > 0) this.emitLine();
  }

  private append(segment: string): boolean {
    const segmentBytes = Buffer.byteLength(segment);
    if (this.#lineBufferBytes + segmentBytes > lineLimit) return false;
    this.#lineBuffer += segment;
    this.#lineBufferBytes += segmentBytes;
    return true;
  }

  private overflow(hasNewline: boolean): void {
    this.clearLine();
    this.#pendingCarriageReturn = false;
    if (hasNewline) this.recordOversizedLine();
    else this.#discardingLine = true;
  }

  private emitLine(): void {
    const line = this.#lineBuffer;
    this.clearLine();
    this.#pendingCarriageReturn = false;
    this.#onLine(line);
  }

  private clearLine(): void {
    this.#lineBuffer = '';
    this.#lineBufferBytes = 0;
  }

  private recordOversizedLine(): void {
    this.#oversizedLineCount = Math.min(
      this.#oversizedLineCount + 1,
      Number.MAX_SAFE_INTEGER,
    );
  }
}
