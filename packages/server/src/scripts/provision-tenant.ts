/**
 * 6-20 平台开通新客户(老板)账号。签约 + 收营业执照后, 平台方(我们)运行此脚本:
 *   创建租户(录入营业执照/实名, 标记已认证) + 老板 owner 主账号(绑老板手机号)。
 *   老板随后用「手机号 + 验证码」登录(无需密码), 进系统自己邀请运营/销售。
 *
 * 用法(在服务器 packages/server 下):
 *   pnpm provision:tenant --company "顺仕美途" --phone 13800138000 --name 韩老板 \
 *     --credit 91110108MA01XXXX2B --legal 韩某某 --plan basic
 *
 *   必填: --company(公司名) --phone(老板手机号) --name(老板姓名)
 *   选填: --credit(统一社会信用代码) --legal(法人) --license(营业执照图URL) --plan(trial|basic|pro, 默认 trial)
 */
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, closePool } from "../models/db.js";
import { tenants, users } from "../models/schema.js";

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
  const company = args.company?.trim();
  const phone = args.phone?.trim();
  const name = args.name?.trim();
  const creditCode = args.credit?.trim() || null;
  const legalPerson = args.legal?.trim() || null;
  const businessLicenseUrl = args.license?.trim() || null;
  const plan = (args.plan?.trim() || "trial").toLowerCase();

  // 校验
  const errs: string[] = [];
  if (!company) errs.push("缺 --company(公司名)");
  if (!name) errs.push("缺 --name(老板姓名)");
  if (!phone || !/^1[3-9]\d{9}$/.test(phone)) errs.push("--phone 手机号格式不正确");
  if (!["free", "trial", "basic", "pro"].includes(plan)) errs.push("--plan 须为 free|trial|basic|pro");
  if (errs.length) {
    console.error("❌ 参数错误:\n  " + errs.join("\n  "));
    console.error("\n示例: pnpm provision:tenant --company \"顺仕美途\" --phone 13800138000 --name 韩老板 --credit 91110108MA01XXXX2B --legal 韩某某 --plan basic");
    process.exitCode = 1;
    return;
  }

  // 唯一性: 手机号未被占用, 信用代码未建过租户
  const [dupUser] = await db.select({ id: users.id }).from(users).where(eq(users.phone, phone!)).limit(1);
  if (dupUser) { console.error(`❌ 手机号 ${phone} 已是某账号, 不能重复开通。`); process.exitCode = 1; return; }
  if (creditCode) {
    const [dupTenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.creditCode, creditCode)).limit(1);
    if (dupTenant) { console.error(`❌ 信用代码 ${creditCode} 已开通过公司(租户 ${dupTenant.id})。`); process.exitCode = 1; return; }
  }

  // 建租户(已认证) + 老板 owner
  const slug = `tenant-${nanoid(8)}`;
  const [tenant] = await db.insert(tenants).values({
    name: company!, slug, plan,
    creditCode, legalPerson, businessLicenseUrl,
    verifiedStatus: creditCode ? "verified" : "unverified",
    verifiedAt: creditCode ? new Date() : null,
    verifiedBy: "provision-script",
  }).returning();
  if (!tenant) { console.error("❌ 租户创建失败"); process.exitCode = 1; return; }

  const [owner] = await db.insert(users).values({
    tenantId: tenant.id, phone: phone!, name: name!, role: "owner",
  }).returning();
  if (!owner) { console.error("❌ 老板账号创建失败"); process.exitCode = 1; return; }

  console.log("\n✅ 开通成功\n");
  console.log(`  公司(租户): ${company}  [${tenant.id}]  套餐=${plan}  认证=${tenant.verifiedStatus}`);
  if (creditCode) console.log(`  营业执照:   信用代码 ${creditCode}  法人 ${legalPerson ?? "—"}`);
  console.log(`  老板账号:   ${name}  ${phone}  [owner ${owner.id}]`);
  console.log(`\n  👉 交付话术: 请用手机号 ${phone} 在登录页选「手机号登录」, 获取验证码即可进入。`);
  console.log(`     首登后到「设置 → 成员管理」邀请你的运营/销售。\n`);
}

main()
  .then(async () => { await closePool(); process.exit(process.exitCode ?? 0); })
  .catch(async (err) => { console.error("开通异常:", err); await closePool(); process.exit(1); });
