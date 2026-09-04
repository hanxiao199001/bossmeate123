/**
 * 大文件走分片 + 上传耗时可见 (9-04)。
 *
 * 【病历】ali-oss 单次 `put` 默认 **60 秒响应超时**。
 * 9-04 存档 69MB 数字人成片时直接 `ResponseTimeoutError`；
 * 而当日备份的 43.5MB **刚好**跑得过去（整个备份任务 77 秒）—— 贴着线。
 *
 * ▎ 库再长一点、或网络慢一点，备份就会稳定失败。
 * ▎ 失败形态是 backup_failed（会正确告警），但那时**已经没有备份了** ——
 * ▎ 告警对了不等于损失没发生。
 *
 * 所以两件事一起做：>20MB 拆掉那条线，同时把耗时记下来让趋势可见。
 */
import { describe, it, expect } from "vitest";
import { MULTIPART_THRESHOLD_BYTES, MULTIPART_PART_SIZE_BYTES } from "../services/storage/index.js";
import { renderUploadTrend, type UploadTrend } from "../services/ops/backup.js";

describe("分片阈值", () => {
  it("阈值 20MB —— 取的是「再慢一倍也不撞线」的位置, 不是「刚好够用」", () => {
    // 43.5MB 实测能过但贴线, 所以阈值不能取 40MB
    expect(MULTIPART_THRESHOLD_BYTES).toBe(20 * 1024 * 1024);
    expect(MULTIPART_THRESHOLD_BYTES).toBeLessThan(43.5 * 1024 * 1024);
  });

  it("当前备份规模(43.5MB)会走分片", () => {
    expect(43.5 * 1024 * 1024 > MULTIPART_THRESHOLD_BYTES).toBe(true);
  });

  it("9-04 那条 69MB 的视频也会走分片(它当初就是这么超时的)", () => {
    expect(69_080_253 > MULTIPART_THRESHOLD_BYTES).toBe(true);
  });

  it("小文件仍走单次 put(分片有额外往返, 不该给小文件用)", () => {
    expect(1024 * 1024 > MULTIPART_THRESHOLD_BYTES).toBe(false);
  });

  it("分片大小满足阿里云 ≥100KB 的要求", () => {
    expect(MULTIPART_PART_SIZE_BYTES).toBeGreaterThanOrEqual(100 * 1024);
  });
});

describe("周报的上传耗时那一行", () => {
  const t = (o: Partial<UploadTrend> = {}): UploadTrend =>
    ({ maxSeconds: 12.3, samples: 7, error: null, ...o });

  it("报最长耗时 + 样本数", () => {
    const out = renderUploadTrend(t());
    expect(out).toContain("12.3");
    expect(out).toContain("7");
  });

  it("🔴 明说「无需处理」—— 一个不需要行动的指标必须说它不需要行动", () => {
    // 8-24 立的规矩: 沉默的指标会被读成"这个我是不是该管"
    expect(renderUploadTrend(t())).toMatch(/无需处理/);
  });

  it("🔴 不许再声称「走分片就不受 60 秒约束」—— 那句话是错的", () => {
    /**
     * 9-04 实测推翻: ali-oss 的 60 秒是**每次 HTTP 响应**的超时,
     * 分片只是把一个大请求拆成多个, 每一片仍受同一条限制
     * (报 `Failed to upload some parts ... part_num: 2`)。
     * 真正解掉它的是客户端 timeout: 600000。
     * 当日 postgres 备份上传 67.3 秒 —— 旧配置下这次必失败。
     */
    const out = renderUploadTrend(t());
    expect(out).not.toMatch(/不再受/);
    expect(out).not.toMatch(/60 秒/);
  });

  it("给出「什么时候不是超时问题」的判据, 而不是让人一直调 timeout", () => {
    expect(renderUploadTrend(t())).toMatch(/300 秒.*带宽/);
  });

  it("给出逐周怎么读, 而不是丢一个裸数字", () => {
    expect(renderUploadTrend(t())).toMatch(/涨/);
  });

  it("🔴 没有样本时不说「一切正常」, 而是提示去看备份在不在跑", () => {
    const out = renderUploadTrend(t({ samples: 0, maxSeconds: null }));
    expect(out).toMatch(/没有成功的备份上传记录/);
    expect(out).toMatch(/备份是否在跑/);
  });

  it("🔴 查不成 ≠ 一切正常", () => {
    const out = renderUploadTrend(t({ error: "column does not exist" }));
    expect(out).toMatch(/没查成/);
    expect(out).toContain("column does not exist");
    expect(out).not.toMatch(/最长/);
  });
});
