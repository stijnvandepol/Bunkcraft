/**
 * Power-of-two size classes of ArrayBuffers that travel between the main thread and the chunk
 * workers. Every fresh ArrayBuffer counts as external memory for V8, and a few MB of them per
 * second while streaming chunks triggers full mark-compact collections; recycling the same buffers
 * (zero-copy transfers in both directions) keeps the heap quiet.
 */
const MIN_CLASS = 10;

function classOf(bytes: number): number {
  return Math.max(MIN_CLASS, 32 - Math.clz32(Math.max(1, bytes) - 1));
}

export class BufferPool {
  private readonly classes: ArrayBuffer[][] = [];
  /** Buffers handed out that did not come from the pool (diagnostics). */
  fresh = 0;
  reused = 0;

  constructor(private readonly maxPerClass = 48) {}

  /** A buffer of at least `bytes` bytes (the next power of two). Contents are NOT cleared. */
  acquire(bytes: number): ArrayBuffer {
    const cls = classOf(bytes);
    const list = this.classes[cls];
    const buf = list?.pop();
    if (buf) {
      this.reused++;
      return buf;
    }
    this.fresh++;
    return new ArrayBuffer(1 << cls);
  }

  /** Takes a buffer back; detached buffers and sizes that are not a power of two are ignored. */
  release(buf: ArrayBuffer): boolean {
    const n = buf.byteLength;
    if (n < 1 << MIN_CLASS || (n & (n - 1)) !== 0) return false;
    const cls = 31 - Math.clz32(n);
    const list = (this.classes[cls] ??= []);
    if (list.length >= this.maxPerClass) return false;
    list.push(buf);
    return true;
  }
}
