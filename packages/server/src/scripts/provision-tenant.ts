/**
 * 6-20 平台开通新客户(老板)账号。7-05 起核心逻辑抽至
 *   services/onboarding/provision-tenant-service.ts(与平台管理端 POST /platform/tenants 共用),
 *   本脚本只做 CLI 参数解析 + 打印(薄包装)。
 *
 * 用法(在服务器 packages/server 下):
 *   pnpm provision:tenant --company "顺仕美途" --phone 13800138000 --name 韩老板 \
 *     --credit 91110108MA01XXXX2B --legal 韩某某 --plan basic
 *
 *   必填: --company(公司名) --phone(老板手机号) --name(老板姓名)
 *   选填: --credit(统一社会信用代码) --legal(法人) --license(营业执照图URL) --plan(trial|basic|pro, 默认 trial)
 */
import { closePool } from "../models/db.js";
import { provisionTenant, ProvisionError } from "../services/onboarding/provision-tenant-service.js";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (key.includes("=")) {
      const [k, ...v] = key.split("=");
      out[k] = v.join("=");
    } else {
      out[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    const { tenant, owner } = await provisionTenant({
      company: args.company ?? "",
      ownerPhone: args.phone ?? "",
      ownerName: args.name ?? "",
      creditCode: args.credit,
      legalPerson: args.legal,
      businessLicenseUrl: args.license,
      plan: args.plan,
      provisionedBy: "provision-script",
    });
    console.log("\n✅ 开通成功\n");
    console.log(`  公司(租户): ${tenant.name}  [${tenant.id}]  套餐=${tenant.plan}  认证=${tenant.verifiedStatus}`);
    if (args.credit) console.log(`  营业执照:   信用代码 ${args.credit}  法人 ${args.legal ?? "—"}`);
    console.log(`  老板账号:   ${owner.name}  ${owner.phone}  [owner ${owner.id}]`);
    console.log(`\n  👉 交付话术: 请用手机号 ${owner.phone} 在登录页选「手机号登录」, 获取验证码即可进入。`);
    console.log(`     首登后到「设置 → 成员管理」邀请你的运营/销售。\n`);
  } catch (err) {
    if (err instanceof ProvisionError) {
      console.error(`❌ ${err.message} [${err.code}]`);
      if (err.code === "INVALID_INPUT") {
        console.error('\n示例: pnpm provision:tenant --company "顺仕美途" --phone 13800138000 --name 韩老板 --credit 91110108MA01XXXX2B --legal 韩某某 --plan basic');
      }
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

main()
  .then(async () => { await closePool(); process.exit(process.exitCode ?? 0); })
  .catch(async (err) => { console.error("开通异常:", err); await closePool(); process.exit(1); });
