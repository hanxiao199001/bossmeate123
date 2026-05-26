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
// PR #237 (5-23): 修 "Credential is not a constructor" — @alicloud/credentials CJS 包 default 在 .default
//   上, TS ESM `import` 拿到 module 对象不是构造函数. 同 avatar20220130. runtime fallback 取 .default 或自身.
/**
 * CJS interop helper: 取 module.default(优先) 或 module 自身, 防 default 在 wrapper 里的情况.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unwrapCtor<T>(mod: T): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = mod as any;
  return (typeof m === "function") ? m : (m?.default ?? m);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createDvhClient(): any {
  const akId = process.env.ALIYUN_ACCESS_KEY_ID;
  const akSecret = process.env.ALIYUN_ACCESS_KEY_SECRET;
  if (!akId || !akSecret) throw new Error("DVH: ALIYUN_ACCESS_KEY_ID / SECRET 缺失");
  const CredentialCtor = unwrapCtor(Credential);
  const AvatarClientCtor = unwrapCtor(avatar20220130);
  const credential = new CredentialCtor(
    new $Credential.Config({ type: "access_key", accessKeyId: akId, accessKeySecret: akSecret }),
  );
  const config = new $OpenApi.Config({ credential });
  config.endpoint = DVH_ENDPOINT;
  return new AvatarClientCtor(config);
}

export { $avatar20220130 };
