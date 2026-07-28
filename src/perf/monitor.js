// Frame-time monitor. Reports a rolling average so the critic harness can
// assert the 16.6ms budget over a sustained orbit rather than a lucky frame.

export class PerfMonitor {
  constructor(window = 120) {
    this.samples = new Float32Array(window);
    this.index = 0;
    this.filled = 0;
    this._start = 0;
    this.lastMs = 0;
  }

  begin() { this._start = performance.now(); }

  end() {
    const ms = performance.now() - this._start;
    this.lastMs = ms;
    this.samples[this.index] = ms;
    this.index = (this.index + 1) % this.samples.length;
    this.filled = Math.min(this.filled + 1, this.samples.length);
  }

  /** Mean CPU-side frame time in ms. */
  get avgMs() {
    if (!this.filled) return 0;
    let sum = 0;
    for (let i = 0; i < this.filled; i++) sum += this.samples[i];
    return sum / this.filled;
  }

  /** 95th percentile — catches hitching the mean hides. */
  get p95Ms() {
    if (!this.filled) return 0;
    const arr = Array.from(this.samples.slice(0, this.filled)).sort((a, b) => a - b);
    return arr[Math.floor(arr.length * 0.95)];
  }

  get fps() { return this.avgMs > 0 ? 1000 / this.avgMs : 0; }

  reset() { this.index = 0; this.filled = 0; }
}
