import { OpenAIHttpError } from "./errors.js";

export class Semaphore {
  private active = 0;

  constructor(private readonly maximum: number) {}

  get inUse() {
    return this.active;
  }

  acquire() {
    if (this.active >= this.maximum) {
      throw new OpenAIHttpError(
        429,
        "concurrency_limit_exceeded",
        `The bridge is already running ${this.maximum} concurrent requests.`,
        "rate_limit_error",
      );
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
    };
  }
}
