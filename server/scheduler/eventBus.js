// 事件总线：任务状态广播给所有 SSE 客户端
export class EventBus {
  constructor() {
    this.listeners = new Set();
  }
  onBroadcast(fn) {
    this.listeners.add(fn);
  }
  emit(evt) {
    evt.ts = Date.now();
    for (const fn of this.listeners) {
      try { fn(evt); } catch (e) { console.error('[eventBus]', e); }
    }
  }
}
