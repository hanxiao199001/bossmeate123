/**
 * DVH (Aliyun Avatar) client factory.
 * 显式 wire ALIYUN_ACCESS_KEY_ID/SECRET（prod 老命名，SDK 默认链 ALIBABA_CLOUD_* 不匹配）。
 */
// @ts-expect-error — SDK 不强类型
import avatar20220130, * as $avatar20220130 from "@alicloud/avatar20220130";
// @ts-expect-error
import * as $OpenApi from "@alicloud/openapi-client";
// @ts-expect-error
import Credential, * as $Credential from "@alicloud/credentials";

const DVH_ENDPOINT = "avatar.cn-zhangjiakou.aliyuncs.com";

export function isRealMode(): boolean {
  return process.env.DVH_REAL_MODE === "true";
}

export function createDvhClient(): InstanceType<typeof avatar20220130> {
  const akId = process.env.ALIYUN_ACCESS_KEY_ID;
  const akSecret = process.env.ALIYUN_ACCESS_KEY_SECRET;
  if (!akId || !akSecret) throw new Error("DVH: ALIYUN_ACCESS_KEY_ID / SECRET 缺失");
  const credential = new Credential(
    new $Credential.Config({ type: "access_key", accessKeyId: akId, accessKeySecret: akSecret }),
  );
  const config = new $OpenApi.Config({ credential });
  config.endpoint = DVH_ENDPOINT;
  return new avatar20220130(config);
}

export { $avatar20220130 };
