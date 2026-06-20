/**
 * 6-19: 从阿里云 DVH 拉取账号下可用的数字人形象列表(queryAvatarList, 分页)。
 *   给前端"形象目录管理"用 —— 管理员拉出来, 选几个(尤其加男形象)入目录, 再绑给不同账号防查重。
 */
import * as $Util from "@alicloud/tea-util";
import { createDvhClient, $avatar20220130 } from "./client.js";
import { logger } from "../../config/logger.js";

export interface DvhAvatarItem {
  code: string;
  name: string;
  preview?: string;     // 预览图/封面 URL
  avatarType?: string;  // 形象类型
  modelType?: string;   // 2D/3D
  makeStatus?: string;  // 制作状态
}

export async function listDvhAvatars(): Promise<DvhAvatarItem[]> {
  const client = createDvhClient();
  const tidRaw = process.env.DVH_TENANT_ID;
  const tid = tidRaw ? parseInt(tidRaw, 10) : undefined;
  const out: DvhAvatarItem[] = [];
  let pageNo = 1;
  for (let guard = 0; guard < 20; guard++) {
    const req = new $avatar20220130.QueryAvatarListRequest({
      pageNo,
      pageSize: 50,
      ...(tid != null && Number.isFinite(tid) ? { tenantId: tid } : {}),
    });
    const resp = await client.queryAvatarListWithOptions(req, new $Util.RuntimeOptions({}));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (resp as any)?.body?.data;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const list = (data?.list ?? []) as Array<Record<string, any>>;
    for (const a of list) {
      if (!a?.code) continue;
      out.push({
        code: String(a.code),
        name: String(a.name || a.code),
        preview: a.preview || a.image || a.portrait || undefined,
        avatarType: a.avatarType ? String(a.avatarType) : undefined,
        modelType: a.modelType ? String(a.modelType) : undefined,
        makeStatus: a.makeStatus ? String(a.makeStatus) : undefined,
      });
    }
    const totalPage = Number(data?.totalPage ?? 1);
    if (list.length === 0 || pageNo >= totalPage) break;
    pageNo++;
  }
  logger.info({ count: out.length }, "DVH 拉取阿里云可用形象完成");
  return out;
}
