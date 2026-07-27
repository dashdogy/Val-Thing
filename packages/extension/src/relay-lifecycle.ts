export function throwIfRelayCancelled(signal: AbortSignal) {
  if (signal.aborted) {
    throw new DOMException("The relay request was cancelled.", "AbortError");
  }
}

export class RelayLifecycleRegistry {
  private readonly controllers = new Map<string, AbortController>();

  async run<T>(
    requestId: string,
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.controllers.has(requestId)) {
      throw new Error(`Relay request ${requestId} is already active.`);
    }
    const controller = new AbortController();
    this.controllers.set(requestId, controller);
    try {
      return await action(controller.signal);
    } finally {
      if (this.controllers.get(requestId) === controller) {
        this.controllers.delete(requestId);
      }
    }
  }

  cancel(requestId: string) {
    const controller = this.controllers.get(requestId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  cancelAll() {
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
  }

  ids() {
    return [...this.controllers.keys()];
  }
}
