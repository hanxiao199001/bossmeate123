/**
 * DVH (Aliyun Avatar) client factory.
 * 显式 wire ALIYUN_ACCESS_KEY_ID/SECRET（prod 老命名，SDK 默认链 ALIBABA_CLOUD_* 不匹配）。
 */
import avatar20220130, * as $avatar20220130 from "@alicloud/avatar20220130";
import * as $OpenApi from "@alicloud/openapi-client";
import Credential, * as $Credential from "@alicloud/credentials";

const DVH_ENDPOINT = "avatar.cn-zhangjiakou.aliyuncs.com";

export function isRealMode(): boolean {
  return process.env.DVH_REAL_MODE === "true";
}

// 返回 any — SDK 用 CJS `export = Class`，TS strict 把 default 推断为 namespace 不是 constructor。
// callers (submit-task / query-task) 用 client.xxxWithOptions() 调方法，any 兜底。
// TODO 5-22 后：用 SDK 正规 namespace import / factory pattern 替代 as any。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createDvhClient(): any {
  const akId = process.env.ALIYUN_ACCESS_KEY_ID;
  const akSecret = process.env.ALIYUN_ACCESS_KEY_SECRET;
  if (!akId || !akSecret) throw new Error("DVH: ALIYUN_ACCESS_KEY_ID / SECRET 缺失");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const credential = new (Credential as any)(
    new $Credential.Config({ type: "access_key", accessKeyId: akId, accessKeySecret: akSecret }),
  );
  const config = new $OpenApi.Config({ credential });
  config.endpoint = DVH_ENDPOINT;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (avatar20220130 as any)(config);
}

export { $avatar20220130 };
