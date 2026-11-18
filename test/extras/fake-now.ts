// 测试用的预加载（node --import）：让 `new Date()` 和 `Date.now()` 返回环境变量 TAU_TEST_NOW。
// 值是本地时间，形如 2031-05-06T07:08:09。没设或读不出就什么都不改。
const Real = Date;
const fixed = new Real(process.env.TAU_TEST_NOW ?? "").getTime();

if (!Number.isNaN(fixed)) {
  class FakeDate extends Real {
    constructor(...args: any[]) {
      super(...((args.length === 0 ? [fixed] : args) as [number]));
    }
    static override now(): number {
      return fixed;
    }
  }
  globalThis.Date = FakeDate as unknown as DateConstructor;
}
