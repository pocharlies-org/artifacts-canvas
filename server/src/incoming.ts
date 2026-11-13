/**
 * What a connection's socket has delivered toward a WebSocket message that is not complete yet
 * (review S8): `ws` keeps every byte of a frame until the frame is complete, and every fragment of
 * a message until its last one (up to maxPayload), and emits nothing meanwhile, so none of it is
 * counted in flight or rate limited. A client that sends fragments and never the last one, and
 * answers every ping (a control frame may come between fragments), held it forever: the idle drop
 * looks at pongs only.
 *
 * Fed with every chunk the socket reads (the same chunks `ws` gets, in order), it follows the frame
 * headers of RFC 6455 §5.2 (FIN, opcode, payload length, mask) and nothing else: no payload is
 * copied or kept. `held` is the payload of the data frames of the unfinished message (the frame
 * being received included); `since` is when the first byte of what is unfinished arrived (0 =
 * nothing is). Control frames (ping, pong, close) are skipped: they neither start nor end a message.
 * A malformed header is `ws`'s to refuse (it closes the connection); this never throws.
 */
export class IncomingFrames {
  /** payload bytes of the unfinished data message (complete fragments and the frame in progress) */
  held = 0;
  /** ms timestamp of the first byte of what is unfinished; 0 = nothing is */
  since = 0;
  private readonly head = new Uint8Array(14);
  private headLen = 0;
  private headNeed = 2;
  /** payload bytes of the current frame still to come; -1 = between frames */
  private left = -1;
  private control = false;
  private fin = false;
  /** a data frame of a message without its last frame yet has started */
  private message = false;

  feed(chunk: Uint8Array, now: number): void {
    let i = 0;
    const n = chunk.length;
    while (i < n) {
      if (this.left < 0) {
        if (this.since === 0) this.since = now;
        const take = Math.min(this.headNeed - this.headLen, n - i);
        this.head.set(chunk.subarray(i, i + take), this.headLen);
        this.headLen += take;
        i += take;
        if (this.headLen === 2 && this.headNeed === 2) {
          const len7 = this.head[1] & 0x7f;
          this.headNeed = 2 + (len7 === 126 ? 2 : len7 === 127 ? 8 : 0) + (this.head[1] & 0x80 ? 4 : 0);
        }
        if (this.headLen < this.headNeed) continue;
        const len7 = this.head[1] & 0x7f;
        const dv = new DataView(this.head.buffer, this.head.byteOffset, this.headNeed);
        this.left = len7 === 126 ? dv.getUint16(2) : len7 === 127 ? dv.getUint32(2) * 2 ** 32 + dv.getUint32(6) : len7;
        this.fin = (this.head[0] & 0x80) !== 0;
        this.control = (this.head[0] & 0x08) !== 0; // opcodes 0x8-0xF
        if (!this.control) this.message = true;
        this.headLen = 0;
        this.headNeed = 2;
        if (this.left === 0) this.endFrame();
        continue;
      }
      const take = Math.min(this.left, n - i);
      i += take;
      this.left -= take;
      if (!this.control) this.held += take;
      if (this.left === 0) this.endFrame();
    }
  }

  private endFrame(): void {
    this.left = -1;
    if (!this.control && this.fin) {
      this.message = false;
      this.held = 0;
    }
    if (!this.message) this.since = 0;
  }
}
