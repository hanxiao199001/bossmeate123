/**
 * Day 2 PR B: admin 期刊管理页 hook。
 * 封装 list + patch + re-enrich 三类调用，把 page 组件的逻辑压在 UI 层。
 */
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../utils/api";
import { toast } from "../components/Toast";

export interface AdminJournal {
  id: string;
  name: string;
  nameEn?: string | null;
  issn?: string | null;
  publisher?: string | null;
  discipline?: string | null;
  partition?: string | null;
  impactFactor?: number | null;
  acceptanceRate?: number | null;
  reviewCycle?: string | null;
  annualVolume?: number | null;
  apcFee?: number | null;
  website?: string | null;
  isWarningList: boolean;
  warningYear?: string | null;
  // 8 个 jsonb 字段：admin 页只关心是否为 null（覆盖率 dots）
  ifHistory?: unknown;
  carIndexHistory?: unknown;
  publicationStats?: unknown;
  jcrFull?: unknown;
  citingJournalsTop10?: unknown;
  scopeDetails?: unknown;
  publicationCosts?: unknown;
  topInstitutions?: unknown;
}

interface ListResp {
  items: AdminJournal[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AdminFilters {
  discipline?: string;
  keyword?: string;
  pageSize?: number;
}

export type EditableField =
  | "discipline" | "partition" | "impactFactor" | "acceptanceRate"
  | "reviewCycle" | "publisher" | "website" | "annualVolume" | "apcFee";

export type PatchPayload = Partial<Pick<AdminJournal, EditableField>>;

export function useJournalsAdmin() {
  const [items, setItems] = useState<AdminJournal[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<AdminFilters>({ pageSize: 100 });

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (filters.discipline) qs.set("discipline", filters.discipline);
      if (filters.keyword) qs.set("keyword", filters.keyword);
      qs.set("pageSize", String(filters.pageSize ?? 100));
      const res = await api.get<ListResp>(`/journals?${qs.toString()}`);
      setItems(res.data?.items ?? []);
      setTotal(res.data?.total ?? 0);
    } catch {
      // api.ts 已 toast
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const patchJournal = useCallback(async (id: string, payload: PatchPayload) => {
    try {
      const res = await api.patch<AdminJournal>(`/journals/${id}`, payload);
      // 局部替换，避免整表 refetch 抖动
      setItems((prev) => prev.map((j) => (j.id === id ? { ...j, ...(res.data ?? {}) } : j)));
      toast.success("已保存");
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.code === "VALIDATION_ERROR") {
        toast.error("字段格式不正确（检查 IF / 录用率 / website URL）");
      } else if (!(err instanceof ApiError)) {
        toast.error("保存失败，请稍后重试");
      }
      return false;
    }
  }, []);

  const reEnrich = useCallback(async (id: string) => {
    try {
      const res = await api.post<{ jobId: string }>(`/journals/${id}/enrich`, {});
      toast.success(`已推送 enrich 任务 ${res.data?.jobId ?? ""}`);
      // 5s 后 refetch（worker 一般 3-8s 完成单条）
      setTimeout(() => { refetch(); }, 5000);
    } catch {
      // api.ts 已 toast
    }
  }, [refetch]);

  return { items, total, loading, filters, setFilters, refetch, patchJournal, reEnrich };
}
