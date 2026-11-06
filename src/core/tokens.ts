const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/;
const MESSAGE_OVERHEAD = 4;

export function estimateText(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (CJK.test(char)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 4);
}

export class TokenEstimator {
  #factor = 1;

  estimateText(text: string): number {
    return Math.max(1, Math.ceil(estimateText(text) * this.#factor));
  }

  estimateMessages(messages: { role: string; content?: unknown }[]): number {
    let total = 0;
    for (const message of messages) {
      const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
      total += this.estimateText(content) + MESSAGE_OVERHEAD;
    }
    return total;
  }

  observe(estimated: number, actual: number): void {
    if (estimated <= 0 || actual <= 0) return;
    this.#factor = Math.min(2, Math.max(0.5, actual / estimated));
  }

  get factor(): number {
    return this.#factor;
  }
}
