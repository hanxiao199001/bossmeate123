/**
 * 反向守卫: 每一个会落库的 incident kind, 都必须有人话 label (9-03)。
 *
 * ## 为什么要这道守卫
 *
 * 「新增 kind 时忘了补 KIND_LABEL」已经是**第三次**:
 *   8-02  degenerate_fallback_route  —— 已出现 5 次, 简报里一直念英文 kind
 *   8-24  周报「内部标识符裸奔」修复
 *   9-03  dvh_bg_resolution_rejected —— 已实发 3 次; dvh_task_failed 0 次但同样缺
 *
 * 病根是结构性的: **落库点和 label 在两个文件里**
 * (各 service 文件里的 recordIncident vs ops/incidents.ts 的 KIND_LABEL),
 * 加落库点时很容易只改一处, 而漏掉的后果要等到简报真念出英文那天才被人看见。
 *
 * 前两次的处置都是「补上那一条」—— 约束等级 ④(靠人记得)。
 * 今天这次改成**合并前就红**(等级 ②): 判据不再依赖任何人记得。
 *
 * ## 判据
 *
 * 扫 packages/server/src 下所有 `recordIncident` / `recordIncidentThrottled`
 * 调用点后面的 `kind: "..."` 字面量, 逐个比对 KIND_LABEL。
 *
 * 刻意**不**扫全部 `kind:` —— 那个键名还被 cost_ledger(kind: "dvh"/"llm")、
 * deferred(kind: "dvh_text"/"article_generation")、failure-kind 等复用,
 * 一把梭会把不相干的键拖进来, 然后为了让测试变绿而堆白名单 ——
 * 那就又变回了「靠人维护一张表」。
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { KIND_LABEL } from "../services/ops/incidents.js";

const SRC = join(fileURLToPath(new URL("../", import.meta.url)));

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of readdirSync(dir)) {
    const full = join(dir, ent);
    if (statSync(full).isDirectory()) {
      if (ent === "__tests__" || ent === "node_modules") continue;
      walk(full, out);
    } else if (ent.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/** 从 recordIncident(...) 调用点起向后 600 字符内找 kind 字面量 */
function collectIncidentKinds(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of walk(SRC)) {
    const src = readFileSync(file, "utf8");
    // 定义处本身不算调用点
    if (file.endsWith("ops/incidents.ts")) continue;
    const callRe = /recordIncident(?:Throttled)?\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(src)) !== null) {
      const window = src.slice(m.index, m.index + 600);
      const km = /\bkind:\s*"([a-z0-9_]+)"/i.exec(window);
      if (!km) continue;                       // 变量传入的(如 kind: k)跳过, 静态扫不出来
      const rel = file.slice(file.indexOf("packages/server/src"));
      const list = found.get(km[1]) ?? [];
      if (!list.includes(rel)) list.push(rel);
      found.set(km[1], list);
    }
  }
  return found;
}

describe("每个会落库的 incident kind 都要有人话 label", () => {
  it("扫描本身要有效 —— 至少扫出一批 kind(否则正则失效了, 测试会假绿)", () => {
    const kinds = collectIncidentKinds();
    // 🔴 这条锁的是守卫自己: 正则哪天失配, 上面那条会因为"零个 kind 全都合规"而通过。
    //    一个扫不到东西的扫描器和一个全部通过的扫描器长得一模一样(红线 #23 同族)。
    expect(kinds.size).toBeGreaterThan(20);
  });

  it("🔴 没有一个 kind 缺 KIND_LABEL", () => {
    const kinds = collectIncidentKinds();
    const missing = [...kinds.entries()]
      .filter(([k]) => !KIND_LABEL[k])
      .map(([k, files]) => `  · ${k}  ← ${files.join(", ")}`);
    expect(
      missing,
      "以下 incident kind 没有人话 label, 简报会直接把英文标识符念给运营:\n" +
        missing.join("\n") +
        "\n改法: 在 services/ops/incidents.ts 的 KIND_LABEL 里补一行。",
    ).toEqual([]);
  });

  it("label 不许拿 kind 本身充数(补了等于没补)", () => {
    for (const [k, label] of Object.entries(KIND_LABEL)) {
      expect(label, `${k} 的 label 与 kind 同名`).not.toBe(k);
      expect(label.trim().length, `${k} 的 label 为空`).toBeGreaterThan(0);
    }
  });
});
