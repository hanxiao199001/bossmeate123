import { useState, useEffect, useCallback } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuthStore } from "../hooks/useAuthStore";
import { api } from "../utils/api";

// ===== 工作流类型 =====
type WorkflowType = "article" | "video";

// ===== 步骤定义 =====
interface StepDef { key: string; label: string; desc: string; icon: string }

const ARTICLE_STEPS: StepDef[] = [
  { key: "search",   label: "关键词搜索", desc: "抓取多平台热门关键词",    icon: "1" },
  { key: "cluster",  label: "关键词聚类", desc: "AI聚类为2-3个关联组合",   icon: "2" },
  { key: "title",    label: "标题生成",   desc: "生成SEO引流标题",        icon: "3" },
  { key: "find",     label: "找期刊文章", desc: "LetPub/知网匹配专业文献", icon: "4" },
  { key: "template", label: "匹配模版",   desc: "选择文章结构模版",        icon: "5" },
  { key: "create",   label: "创作图文",   desc: "AI生成专业图文文章",      icon: "6" },
  { key: "verify",   label: "核对准确度", desc: "LetPub/知网交叉验证",     icon: "7" },
  { key: "publish",  label: "一键发布",   desc: "发布到公众号等平台",      icon: "8" },
];

const VIDEO_STEPS: StepDef[] = [
  { key: "search",   label: "关键词搜索", desc: "抓取多平台热门关键词",    icon: "1" },
  { key: "cluster",  label: "关键词聚类", desc: "AI聚类为2-3个关联组合",   icon: "2" },
  { key: "title",    label: "标题生成",   desc: "生成SEO引流标题",        icon: "3" },
  { key: "find",     label: "找期刊文章", desc: "LetPub/知网匹配专业文献", icon: "4" },
  { key: "script",   label: "视频脚本",   desc: "AI生成视频口播脚本",      icon: "5" },
  { key: "produce",  label: "视频生成",   desc: "文字转视频/数字人",       icon: "6" },
  { key: "verify",   label: "核对准确度", desc: "核对文献信息准确性",      icon: "7" },
  { key: "publish",  label: "一键发布",   desc: "发布到视频号等平台",      icon: "8" },
];

// ===== 文章模版定义 =====
interface ArticleTemplate {
  id: string;
  name: string;
  desc: string;
  icon: string;
  sections: string[];
}

const ARTICLE_TEMPLATES: ArticleTemplate[] = [
  {
    id: "recommend",
    name: "期刊推荐型",
    desc: "推荐2-3本期刊，适合引流获客",
    icon: "\u2B50",
    sections: ["导语（痛点切入）", "期刊推荐 x 3", "投稿建议", "总结引导"],
  },
  {
    id: "popular",
    name: "热点科普型",
    desc: "结合学术热点解读，引发关注",
    icon: "\uD83D\uDD25",
    sections: ["热点引入", "专业解读", "相关期刊推荐", "投稿指南", "总结"],
  },
  {
    id: "compare",
    name: "对比分析型",
    desc: "多本期刊横向对比，帮读者选刊",
    icon: "\uD83D\uDCCA",
    sections: ["背景介绍", "期刊对比表", "优劣势分析", "推荐方案", "总结"],
  },
  {
    id: "guide",
    name: "速发攻略型",
    desc: "快速录用攻略，适合急需发表的客户",
    icon: "\uD83D\uDE80",
    sections: ["痛点开场", "快录期刊推荐", "投稿技巧", "时间规划", "引导咨询"],
  },
];

// ===== 聚类相关类型 =====
interface KeywordCluster {
  id: string;
  keywords: string[];
  discipline: string;
  track: "domestic" | "sci";
  heatScore: number;
  suggestedTitles: string[];
  reasoning: string;
  createdAt: string;
}

interface ClusterResult {
  clusters: KeywordCluster[];
  rawKeywordCount: number;
  clusterCount: number;
  durationMs: number;
}

const CLUSTER_DISCIPLINES = [
  { value: "", label: "全部学科" },
  { value: "\u6559\u80B2", label: "教育" },
  { value: "\u7ECF\u6D4E\u7BA1\u7406", label: "经济管理" },
  { value: "\u533B\u5B66", label: "医学" },
  { value: "\u519C\u6797", label: "农林" },
  { value: "\u5DE5\u7A0B\u6280\u672F", label: "工程技术" },
  { value: "\u6CD5\u5B66", label: "法学" },
  { value: "\u5FC3\u7406\u5B66", label: "心理学" },
];

const TRACK_LABELS: Record<string, string> = { domestic: "国内核心", sci: "国际SCI" };
const TRACK_COLORS: Record<string, string> = {
  domestic: "bg-orange-100 text-orange-700",
  sci: "bg-purple-100 text-purple-700",
};

export default function WorkflowPage() {
  const { type } = useParams<{ type: string }>();
  const workflowType: WorkflowType = type === "video" ? "video" : "article";
  const steps = workflowType === "article" ? ARTICLE_STEPS : VIDEO_STEPS;
  const workflowTitle = workflowType === "article" ? "图文创作" : "视频制作";

  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  const [currentStep, setCurrentStep] = useState(0);
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(new Set());

  // ===== Step 1-3 =====
  const [clusterTrack, setClusterTrack] = useState<"domestic" | "sci" | "all">("domestic");
  const [clusterDiscipline, setClusterDiscipline] = useState("");
  const [clustering, setClustering] = useState(false);
  const [clusterResult, setClusterResult] = useState<ClusterResult | null>(null);
  const [selectedCluster, setSelectedCluster] = useState<KeywordCluster | null>(null);
  const [selectedTitle, setSelectedTitle] = useState("");

  // ===== Step 4 =====
  const [matchingJournals, setMatchingJournals] = useState(false);
  const [matchedJournals, setMatchedJournals] = useState<any[]>([]);
  const [selectedJournals, setSelectedJournals] = useState<Set<string>>(new Set());
  const [journalSeeded, setJournalSeeded] = useState(false);

  // ===== Step 5 =====
  const [selectedTemplate, setSelectedTemplate] = useState<string>("");
  // 风格学习
  const [styleLearning, setStyleLearning] = useState(false);
  const [styleProgress, setStyleProgress] = useState<string[]>([]);
  const [learnedTpls, setLearnedTpls] = useState<Array<{
    id: string; name: string; desc: string; icon: string; source: string;
    sourceAccount?: string; sections: string[]; titleFormula?: string;
    styleTags?: string[]; sampleTitle?: string; prompt?: string;
  }>>([]);
  const [learnedTplsLoaded, setLearnedTplsLoaded] = useState(false);
  const [styleAnalysesData, setStyleAnalysesData] = useState<any[]>([]);
  const [showLearnPanel, setShowLearnPanel] = useState(false);

  // ===== Step 6 =====
  const [generating, setGenerating] = useState(false);
  const [generatedArticle, setGeneratedArticle] = useState("");
  const [generateError, setGenerateError] = useState("");

  // ===== Step 7 =====
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<any>(null);

  // 自动修正
  const [autoFixing, setAutoFixing] = useState(false);
  const [autoFixResult, setAutoFixResult] = useState<{
    fixedContent: string;
    fixes: Array<{ field: string; journal: string; from: string; to: string }>;
    aiReview: { issues: string[]; suggestions: string[]; confidence: number };
    fixCount: number;
  } | null>(null);

  // 质量评分
  const [scoringQuality, setScoringQuality] = useState(false);
  const [qualityScore, setQualityScore] = useState<{
    overall: number;
    publishReady: boolean;
    dimensions: {
      readability: { score: number; details: { paragraphCount: number; sentenceCount: number; avgSentenceLength: number; headingCount: number; tips: string[] } };
      seo: { score: number; details: { keywordDensity: Record<string, number>; titleContainsKeyword: boolean; contentLength: number; tips: string[] } };
      structure: { score: number; details: { hasIntro: boolean; hasConclusion: boolean; hasList: boolean; hasEmphasis: boolean; tips: string[] } };
    };
    allTips: string[];
  } | null>(null);

  // ===== Step 8 =====
  const [editableArticle, setEditableArticle] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportedHtml, setExportedHtml] = useState("");
  const [wechatStatus, setWechatStatus] = useState<"loading" | "verified" | "configured" | "none">("loading");
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<{ ok: boolean; msg: string; mediaId?: string } | null>(null);

  // 多平台发布 state
  const [platformAccounts, setPlatformAccounts] = useState<{ id: string; platform: string; accountName: string; isVerified: boolean; status: string }[]>([]);
  const [platformAccountsLoading, setPlatformAccountsLoading] = useState(false);
  const [platformAccountsLoaded, setPlatformAccountsLoaded] = useState(false);
  const [selectedPlatformIds, setSelectedPlatformIds] = useState<string[]>([]);
  const [multiPublishing, setMultiPublishing] = useState(false);
  const [multiPublishResults, setMultiPublishResults] = useState<{ accountId: string; accountName: string; platform: string; success: boolean; message?: string; error?: string }[]>([]);
  const [multiPublishMsg, setMultiPublishMsg] = useState("");

  // 进入Step 8时初始化可编辑文章 + 检查微信配置 + 加载多平台账号
  useEffect(() => {
    if (currentStep === 7 && generatedArticle && !editableArticle) {
      setEditableArticle(generatedArticle);
    }
    if (currentStep === 7 && wechatStatus === "loading") {
      api.get<any>("/wechat/config").then((res) => {
        if (!res.data) setWechatStatus("none");
        else if (res.data.isVerified) setWechatStatus("verified");
        else setWechatStatus("configured");
      }).catch(() => setWechatStatus("none"));
    }
    // 加载多平台账号
    if (currentStep === 7 && !platformAccountsLoaded && !platformAccountsLoading) {
      setPlatformAccountsLoading(true);
      api.get<any>("/accounts").then((res) => {
        const list = res.data;
        setPlatformAccounts(Array.isArray(list) ? list : []);
      }).catch(() => {
        setPlatformAccounts([]);
      }).finally(() => { setPlatformAccountsLoading(false); setPlatformAccountsLoaded(true); });
    }
  }, [currentStep, generatedArticle, editableArticle, wechatStatus, platformAccountsLoaded, platformAccountsLoading]);

  // 进入Step 5时加载已学习的模版
  useEffect(() => {
    if (currentStep === 4 && !learnedTplsLoaded) {
      setLearnedTplsLoaded(true);
      api.get<any>("/workflow/learned-templates").then((res) => {
        if (res.data && Array.isArray(res.data)) {
          setLearnedTpls(res.data.map((t: any) => ({
            id: t.id, name: t.name, desc: t.desc || "", icon: t.icon || "📝",
            source: t.source, sourceAccount: t.sourceAccount,
            sections: Array.isArray(t.sections) ? t.sections : [],
            titleFormula: t.titleFormula, styleTags: t.styleTags,
            sampleTitle: t.sampleTitle, prompt: t.prompt,
          })));
        }
      }).catch(() => {});
      api.get<any>("/workflow/style-analyses").then((res) => {
        if (res.data && Array.isArray(res.data)) setStyleAnalysesData(res.data);
      }).catch(() => {});
    }
  }, [currentStep, learnedTplsLoaded]);

  // 触发风格学习
  const handleStyleLearn = async () => {
    setStyleLearning(true);
    setStyleProgress(["开始风格学习..."]);
    try {
      const res = await api.post<any>("/workflow/learn-style", {
        learnSelf: true,
        learnPeers: true,
        selfCount: 20,
        peerMaxPerAccount: 5,
      });
      if (res.data) {
        setStyleProgress(res.data.progress || ["学习完成"]);
        if (res.data.templates && res.data.templates.length > 0) {
          const newTpls = res.data.templates.map((t: any) => ({
            id: t.id || `learned_${Date.now()}_${Math.random()}`,
            name: t.name, desc: t.desc || "", icon: t.icon || "📝",
            source: t.source, sourceAccount: t.sourceAccount,
            sections: Array.isArray(t.sections) ? t.sections : [],
            titleFormula: t.titleFormula, styleTags: t.styleTags,
            sampleTitle: t.sampleTitle, prompt: t.prompt,
          }));
          setLearnedTpls(newTpls);
        }
        if (res.data.analyses) setStyleAnalysesData(res.data.analyses);
      }
    } catch (err: any) {
      setStyleProgress((prev) => [...prev, `学习失败: ${err?.message || "未知错误"}`]);
    } finally {
      setStyleLearning(false);
    }
  };

  // 清空风格学习数据
  const handleClearStyleData = async () => {
    try {
      await api.delete("/workflow/style-analyses");
      setLearnedTpls([]);
      setStyleAnalysesData([]);
      setStyleProgress([]);
    } catch {}
  };

  // 发布到微信公众号草稿箱
  const handleWechatPublish = async () => {
    setPublishing(true);
    setPublishResult(null);
    try {
      const res = await api.post<any>("/wechat/draft", {
        title: selectedTitle,
        content: editableArticle || generatedArticle,
        author: "BossMate AI",
      });
      if (res.code === "ok" && res.data?.success) {
        setPublishResult({ ok: true, msg: res.message || "\u6587\u7AE0\u5DF2\u6210\u529F\u6DFB\u52A0\u5230\u516C\u4F17\u53F7\u8349\u7A3F\u7BB1\uFF01", mediaId: res.data.mediaId });
      } else {
        setPublishResult({ ok: false, msg: res.message || res.data?.error || "\u53D1\u5E03\u5931\u8D25" });
      }
    } catch (err: any) {
      setPublishResult({ ok: false, msg: err?.message || "\u53D1\u5E03\u5931\u8D25" });
    } finally {
      setPublishing(false);
    }
  };

  // 多平台一键发布
  const handleMultiPublish = async () => {
    if (selectedPlatformIds.length === 0) return;
    setMultiPublishing(true);
    setMultiPublishResults([]);
    setMultiPublishMsg("");
    try {
      // 先保存内容到数据库，获取 contentId
      const saveRes = await api.post<any>("/content", {
        type: "article",
        title: selectedTitle,
        body: editableArticle || generatedArticle,
        status: "approved",
      });
      const contentId = saveRes.data?.id;
      if (!contentId) {
        setMultiPublishMsg("保存内容失败，无法发布");
        return;
      }

      const res = await api.post<{ results: any[]; summary: { total: number; success: number; failed: number } }>("/publish", {
        contentId,
        accountIds: selectedPlatformIds,
      });

      if (res.data) {
        setMultiPublishResults(res.data.results || []);
        const s = res.data.summary;
        setMultiPublishMsg(`发布完成：${s.success}/${s.total} 个账号成功${s.failed > 0 ? `，${s.failed} 个失败` : ""}`);
      }
    } catch (err: any) {
      setMultiPublishMsg(`发布出错：${err?.message || "未知错误"}`);
    } finally {
      setMultiPublishing(false);
    }
  };

  const togglePlatformAccount = (id: string) => {
    setSelectedPlatformIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const togglePlatformGroup = (platform: string) => {
    const ids = platformAccounts.filter((a) => a.platform === platform).map((a) => a.id);
    const allSelected = ids.every((id) => selectedPlatformIds.includes(id));
    if (allSelected) {
      setSelectedPlatformIds((prev) => prev.filter((id) => !ids.includes(id)));
    } else {
      setSelectedPlatformIds((prev) => Array.from(new Set([...prev, ...ids])));
    }
  };

  // --- handlers ---
  const handleCluster = async () => {
    setClustering(true);
    setClusterResult(null);
    try {
      const body: Record<string, string> = { track: clusterTrack };
      if (clusterDiscipline) body.discipline = clusterDiscipline;
      const res = await api.post<ClusterResult>("/keywords/clusters", body);
      if (res.data) {
        setClusterResult(res.data);
        setCompletedSteps((prev) => new Set([...prev, 0]));
      }
    } catch (err) { console.error("聚类失败", err); }
    finally { setClustering(false); }
  };

  const handleSelectCluster = (cluster: KeywordCluster) => {
    setSelectedCluster(cluster);
    setCompletedSteps((prev) => new Set([...prev, 1]));
  };

  const handleSelectTitle = (title: string) => {
    setSelectedTitle(title);
    setCompletedSteps((prev) => new Set([...prev, 2]));
    setCurrentStep(3);
  };

  const [journalMatchDone, setJournalMatchDone] = useState(false);

  const handleMatchJournals = useCallback(async () => {
    if (!selectedCluster) return;
    setMatchingJournals(true);
    setMatchedJournals([]);
    setJournalMatchDone(false);
    try {
      if (!journalSeeded) { await api.post("/journals/seed", {}).catch(() => {}); setJournalSeeded(true); }
      const res = await api.post<{ items: any[] }>("/journals/match", {
        keywords: selectedCluster.keywords,
        track: selectedCluster.track,
        discipline: selectedCluster.discipline,
      });
      if (res.data) setMatchedJournals(res.data.items || []);
    } catch (err) { console.error("期刊匹配失败", err); }
    finally { setMatchingJournals(false); setJournalMatchDone(true); }
  }, [selectedCluster, journalSeeded]);

  useEffect(() => {
    if (currentStep === 3 && selectedCluster && !journalMatchDone && !matchingJournals) {
      handleMatchJournals();
    }
  }, [currentStep, selectedCluster, journalMatchDone, matchingJournals, handleMatchJournals]);

  const toggleJournal = (id: string) => {
    setSelectedJournals((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const confirmJournals = () => { setCompletedSteps((prev) => new Set([...prev, 3])); setCurrentStep(4); };

  const handleSelectTemplate = (tid: string) => {
    setSelectedTemplate(tid);
    setCompletedSteps((prev) => new Set([...prev, 4]));
    setCurrentStep(5);
  };

  const handleGenerate = async () => {
    if (!selectedCluster || !selectedTitle) return;
    setGenerating(true);
    setGeneratedArticle("");
    setGenerateError("");
    try {
      const journalData = matchedJournals
        .filter((j) => selectedJournals.has(j.id))
        .map((j) => ({
          name: j.name, nameEn: j.nameEn, partition: j.partition,
          impactFactor: j.impactFactor, acceptanceRate: j.acceptanceRate, reviewCycle: j.reviewCycle,
        }));

      // 如果选了学习模版，提取其风格指令
      let templateId = selectedTemplate || "recommend";
      let stylePrompt = "";
      if (selectedTemplate.startsWith("learned:")) {
        const learnedId = selectedTemplate.replace("learned:", "");
        const lt = learnedTpls.find((t) => t.id === learnedId);
        if (lt) {
          templateId = "recommend"; // 用推荐型作为基础结构
          stylePrompt = lt.prompt || "";
          if (lt.sections.length > 0) {
            stylePrompt += `\n\n文章段落结构：${lt.sections.join(" → ")}`;
          }
        }
      }

      const res = await api.post<{ content: string }>("/workflow/generate-article", {
        keywords: selectedCluster.keywords,
        title: selectedTitle,
        journals: journalData,
        template: templateId,
        discipline: selectedCluster.discipline,
        track: selectedCluster.track,
        stylePrompt,
      });

      if (res.data) {
        setGeneratedArticle(res.data.content);
        setCompletedSteps((prev) => new Set([...prev, 5]));
      }
    } catch (err: any) {
      setGenerateError(err?.message || "生成失败，请重试");
    } finally {
      setGenerating(false);
    }
  };

  // 核对文章准确度
  const handleVerify = async () => {
    if (!generatedArticle) return;
    setVerifying(true);
    setVerifyResult(null);
    try {
      const journalData = matchedJournals
        .filter((j) => selectedJournals.has(j.id))
        .map((j) => ({
          name: j.name, nameEn: j.nameEn, partition: j.partition,
          impactFactor: j.impactFactor, acceptanceRate: j.acceptanceRate, reviewCycle: j.reviewCycle,
        }));

      const res = await api.post<any>("/workflow/verify-article", {
        content: generatedArticle,
        journals: journalData,
      });
      if (res.data) {
        setVerifyResult(res.data);
        setCompletedSteps((prev) => new Set([...prev, 6]));
      }
    } catch (err) { console.error("核对失败", err); }
    finally { setVerifying(false); }
  };

  // 自动修正（优化3+5）
  const handleAutoFix = async () => {
    if (!generatedArticle || !verifyResult) return;
    setAutoFixing(true);
    setAutoFixResult(null);
    try {
      const journalData = matchedJournals
        .filter((j) => selectedJournals.has(j.id))
        .map((j) => ({
          name: j.name, nameEn: j.nameEn, partition: j.partition,
          impactFactor: j.impactFactor, acceptanceRate: j.acceptanceRate, reviewCycle: j.reviewCycle,
        }));

      const res = await api.post<any>("/workflow/auto-fix", {
        content: editableArticle || generatedArticle,
        journals: journalData,
        verifyResults: verifyResult.results,
      });

      if (res.data) {
        setAutoFixResult(res.data);
        // 自动替换文章内容
        if (res.data.fixedContent) {
          setGeneratedArticle(res.data.fixedContent);
          setEditableArticle(res.data.fixedContent);
        }
      }
    } catch (err) { console.error("自动修正失败", err); }
    finally { setAutoFixing(false); }
  };

  // 质量评分（优化4）
  const handleQualityScore = async () => {
    const content = editableArticle || generatedArticle;
    if (!content) return;
    setScoringQuality(true);
    setQualityScore(null);
    try {
      const res = await api.post<any>("/workflow/quality-score", {
        content,
        title: selectedTitle,
        keywords: selectedCluster?.keywords || [],
      });
      if (res.data) {
        setQualityScore(res.data);
      }
    } catch (err) { console.error("质量评分失败", err); }
    finally { setScoringQuality(false); }
  };

  // 进入Step7时自动核对 + 自动评分
  useEffect(() => {
    if (currentStep === 6 && generatedArticle && !verifyResult && !verifying) {
      handleVerify();
    }
    // 核对完成后自动触发质量评分
    if (currentStep === 6 && verifyResult && !qualityScore && !scoringQuality) {
      handleQualityScore();
    }
  }, [currentStep, generatedArticle, verifyResult, verifying, qualityScore, scoringQuality]);

  const canGoToStep = (idx: number) => idx === 0 || completedSteps.has(idx - 1);

  // --- context info bar (reusable) ---
  const ContextBar = () => selectedCluster ? (
    <div className="bg-blue-50 rounded-lg p-3 mb-4">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <div>
          <span className="text-blue-600">关键词：</span>
          {selectedCluster.keywords.map((kw, i) => (
            <span key={i} className="inline-block ml-1 px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">{kw}</span>
          ))}
        </div>
        {selectedTitle && <>
          <span className="text-gray-400">|</span>
          <div className="text-gray-700"><span className="text-blue-600">标题：</span>{selectedTitle}</div>
        </>}
      </div>
    </div>
  ) : null;

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/" className="flex items-center gap-2">
            <span className="text-lg font-bold text-blue-600">BossMate</span>
            <span className="text-xs text-gray-400">AI超级员工</span>
          </Link>
          <span className="text-gray-300">|</span>
          <span className="text-sm font-medium text-gray-700">{workflowTitle}</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-600">{user?.name}</span>
          <button onClick={logout} className="text-sm text-gray-500 hover:text-red-500">退出</button>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto py-6 px-4">
        {/* 步骤条 */}
        <div className="bg-white rounded-xl border border-gray-200 p-4 mb-6">
          <div className="flex items-center">
            {steps.map((step, idx) => {
              const isActive = idx === currentStep;
              const isDone = completedSteps.has(idx);
              const canClick = canGoToStep(idx);
              return (
                <div key={step.key} className="flex items-center flex-1 last:flex-none">
                  <button
                    onClick={() => canClick && setCurrentStep(idx)}
                    disabled={!canClick}
                    className={`flex flex-col items-center gap-1 min-w-0 transition-all ${canClick ? "cursor-pointer" : "cursor-not-allowed opacity-40"}`}
                  >
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all ${
                      isDone ? "bg-green-500 text-white" : isActive ? "bg-blue-500 text-white ring-4 ring-blue-100" : "bg-gray-200 text-gray-500"
                    }`}>
                      {isDone ? "\u2713" : step.icon}
                    </div>
                    <span className={`text-xs font-medium whitespace-nowrap ${isActive ? "text-blue-600" : isDone ? "text-green-600" : "text-gray-400"}`}>
                      {step.label}
                    </span>
                  </button>
                  {idx < steps.length - 1 && (
                    <div className={`flex-1 h-0.5 mx-2 ${completedSteps.has(idx) ? "bg-green-300" : "bg-gray-200"}`} />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ========== Step 1-2-3 ========== */}
        {currentStep <= 2 && (
          <div>
            <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
              <h2 className="text-lg font-bold text-gray-900 mb-1">第一步：关键词搜索 + 智能聚类 + 标题生成</h2>
              <p className="text-sm text-gray-500 mb-4">自动抓取热词 → DeepSeek AI 聚类成2-3个关联组合 → 生成引流标题 → 选择你要用的标题</p>
              <div className="flex items-end gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">业务线</label>
                  <select value={clusterTrack} onChange={(e) => setClusterTrack(e.target.value as any)} className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white">
                    <option value="domestic">国内核心</option>
                    <option value="sci">国际SCI</option>
                    <option value="all">全部</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">学科</label>
                  <select value={clusterDiscipline} onChange={(e) => setClusterDiscipline(e.target.value)} className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white">
                    {CLUSTER_DISCIPLINES.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                  </select>
                </div>
                <button onClick={handleCluster} disabled={clustering}
                  className={`px-6 py-2 rounded-lg text-sm font-medium text-white transition-all ${clustering ? "bg-gray-400 cursor-not-allowed" : "bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 active:scale-95"}`}>
                  {clustering ? "AI分析中..." : "开始搜索 + 聚类"}
                </button>
              </div>
              {clustering && (
                <div className="mt-4 flex items-center gap-2 text-sm text-blue-600">
                  <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                  正在抓取热词 + DeepSeek AI 聚类分析，预计30-60秒...
                </div>
              )}
            </div>

            {clusterResult && (
              <div>
                <div className="grid grid-cols-3 gap-4 mb-6">
                  <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
                    <div className="text-2xl font-bold text-gray-900">{clusterResult.rawKeywordCount}</div>
                    <div className="text-xs text-gray-500">原始热词</div>
                  </div>
                  <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
                    <div className="text-2xl font-bold text-blue-600">{clusterResult.clusterCount}</div>
                    <div className="text-xs text-gray-500">聚类组合</div>
                  </div>
                  <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
                    <div className="text-2xl font-bold text-green-600">{(clusterResult.durationMs / 1000).toFixed(1)}s</div>
                    <div className="text-xs text-gray-500">处理耗时</div>
                  </div>
                </div>
                {!selectedCluster && (
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4 text-sm text-blue-700">
                    请点击下方聚类卡片选择一组关键词，然后选择标题，进入下一步
                  </div>
                )}
                <div className="space-y-4">
                  {clusterResult.clusters.map((cluster, idx) => {
                    const isSel = selectedCluster?.id === cluster.id;
                    return (
                      <div key={cluster.id} onClick={() => handleSelectCluster(cluster)}
                        className={`bg-white rounded-xl border-2 p-5 transition-all cursor-pointer ${isSel ? "border-blue-500 shadow-lg ring-2 ring-blue-100" : "border-gray-200 hover:border-blue-300 hover:shadow-md"}`}>
                        <div className="flex items-start justify-between mb-3">
                          <div className="flex items-center gap-2">
                            <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-white text-xs font-bold ${isSel ? "bg-blue-500" : "bg-gray-400"}`}>{idx + 1}</span>
                            <span className={`text-xs px-2 py-0.5 rounded-full ${TRACK_COLORS[cluster.track]}`}>{TRACK_LABELS[cluster.track]}</span>
                            <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">{cluster.discipline}</span>
                            {isSel && <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">已选中</span>}
                          </div>
                          <div className="text-xs text-gray-400">热度 {cluster.heatScore}</div>
                        </div>
                        <div className="flex gap-2 mb-3">
                          {cluster.keywords.map((kw, i) => (
                            <span key={i} className="inline-block px-3 py-1.5 rounded-lg bg-gray-100 text-sm font-medium text-gray-800 border border-gray-200">{kw}</span>
                          ))}
                        </div>
                        <p className="text-xs text-gray-500 mb-3">{cluster.reasoning}</p>
                        <div className="space-y-2">
                          {cluster.suggestedTitles.map((title, i) => {
                            const isTSel = isSel && selectedTitle === title;
                            return (
                              <div key={i} onClick={(e) => { e.stopPropagation(); if (isSel) handleSelectTitle(title); }}
                                className={`flex items-start gap-2 p-3 rounded-lg border transition-all ${isTSel ? "bg-green-50 border-green-300 ring-1 ring-green-200" : isSel ? "bg-orange-50 border-orange-200 hover:bg-orange-100 cursor-pointer" : "bg-gray-50 border-gray-100"}`}>
                                <span className={`shrink-0 mt-0.5 text-sm font-bold ${isTSel ? "text-green-600" : "text-orange-500"}`}>
                                  {isTSel ? "\u2713" : String.fromCharCode(65 + i)}
                                </span>
                                <span className="text-sm font-medium text-gray-900">{title}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {!clusterResult && !clustering && (
              <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
                <div className="text-5xl mb-4">{"\uD83D\uDD0D"}</div>
                <h3 className="text-lg font-medium text-gray-700 mb-2">选择业务线和学科，点击"开始搜索 + 聚类"</h3>
                <p className="text-sm text-gray-400">AI会自动抓取热门关键词，聚类成2-3个关联组合，并生成引流标题</p>
              </div>
            )}
          </div>
        )}

        {/* ========== Step 4: 找期刊文章 ========== */}
        {currentStep === 3 && (
          <div>
            <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
              <h2 className="text-lg font-bold text-gray-900 mb-1">第四步：找专业期刊文章</h2>
              <p className="text-sm text-gray-500 mb-4">根据已选关键词，从 LetPub 期刊库智能匹配最适合的专业期刊作为参考素材</p>
              <ContextBar />
              <div className="flex items-center gap-3">
                <button onClick={handleMatchJournals} disabled={matchingJournals}
                  className={`px-5 py-2 rounded-lg text-sm font-medium text-white transition-all ${matchingJournals ? "bg-gray-400 cursor-not-allowed" : "bg-blue-600 hover:bg-blue-700 active:scale-95"}`}>
                  {matchingJournals ? "匹配中..." : "重新匹配期刊"}
                </button>
                {selectedJournals.size > 0 && (
                  <button onClick={confirmJournals} className="px-5 py-2 rounded-lg text-sm font-medium text-white bg-green-600 hover:bg-green-700 active:scale-95">
                    确认选择 ({selectedJournals.size}本) → 下一步
                  </button>
                )}
                {matchedJournals.length > 0 && selectedJournals.size === 0 && (
                  <button onClick={confirmJournals} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700">跳过，不选期刊 →</button>
                )}
              </div>
              {matchingJournals && (
                <div className="mt-4 flex items-center gap-2 text-sm text-blue-600">
                  <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                  正在根据关键词匹配最合适的期刊...
                </div>
              )}
            </div>
            {matchedJournals.length > 0 && (
              <div>
                <div className="text-sm text-gray-500 mb-3">找到 {matchedJournals.length} 本相关期刊，点击选择作为参考素材：</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {matchedJournals.map((j: any) => {
                    const isSel = selectedJournals.has(j.id);
                    return (
                      <div key={j.id} onClick={() => toggleJournal(j.id)}
                        className={`bg-white rounded-xl border-2 p-4 cursor-pointer transition-all ${isSel ? "border-green-500 shadow-md ring-1 ring-green-100" : "border-gray-200 hover:border-blue-300 hover:shadow-sm"}`}>
                        <div className="flex items-start justify-between mb-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              {isSel && <span className="shrink-0 w-5 h-5 rounded-full bg-green-500 text-white text-xs flex items-center justify-center">{"\u2713"}</span>}
                              <h4 className="font-bold text-gray-900 text-sm truncate">{j.name}</h4>
                            </div>
                            {j.nameEn && <p className="text-xs text-gray-400 truncate mt-0.5">{j.nameEn}</p>}
                          </div>
                          {j.isWarningList && <span className="shrink-0 text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-600 font-medium">{"\u26A0\uFE0F"} 预警</span>}
                        </div>
                        <div className="flex flex-wrap gap-2 mt-2">
                          {j.partition && <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${j.partition === "Q1" ? "bg-red-100 text-red-700" : j.partition === "Q2" ? "bg-orange-100 text-orange-700" : j.partition === "Q3" ? "bg-yellow-100 text-yellow-700" : "bg-gray-100 text-gray-600"}`}>{j.partition}</span>}
                          {j.impactFactor > 0 && <span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">IF {j.impactFactor}</span>}
                          {j.acceptanceRate > 0 && <span className="text-xs px-2 py-0.5 rounded-full bg-green-50 text-green-700">录用率 {(j.acceptanceRate * 100).toFixed(0)}%</span>}
                          {j.reviewCycle && <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">审稿 {j.reviewCycle}</span>}
                          {j.matchReason === "关键词匹配" && <span className="text-xs px-2 py-0.5 rounded-full bg-purple-50 text-purple-700">{"\u2728"} 关键词匹配</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {!matchingJournals && matchedJournals.length === 0 && (
              <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
                <div className="text-3xl mb-3">{"\uD83D\uDCDA"}</div>
                <p className="text-gray-500 mb-2">暂无匹配的期刊数据</p>
                <button onClick={confirmJournals} className="mt-3 px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700">跳过，进入下一步</button>
              </div>
            )}
          </div>
        )}

        {/* ========== Step 5: 匹配文章模版 ========== */}
        {currentStep === 4 && (
          <div>
            <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
              <h2 className="text-lg font-bold text-gray-900 mb-1">
                {workflowType === "article" ? "第五步：匹配文章模版" : "第五步：视频脚本生成"}
              </h2>
              <p className="text-sm text-gray-500 mb-4">
                {workflowType === "article" ? "选择文章结构模版，AI将按照模版框架生成内容" : "选择脚本风格，AI将生成视频口播脚本"}
              </p>
              <ContextBar />
            </div>

            {workflowType === "article" ? (
              <div>
                {/* 风格学习面板 */}
                <div className="bg-gradient-to-r from-purple-50 to-indigo-50 rounded-xl border border-purple-200 p-5 mb-6">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xl">🧠</span>
                      <h3 className="font-bold text-purple-900">AI风格学习</h3>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-600">
                        {learnedTpls.length > 0 ? `已学习 ${learnedTpls.length} 个模版` : "未学习"}
                      </span>
                    </div>
                    <div className="flex gap-2">
                      {learnedTpls.length > 0 && (
                        <button onClick={handleClearStyleData}
                          className="px-3 py-1.5 text-xs rounded-lg border border-red-200 text-red-500 hover:bg-red-50">
                          清空重学
                        </button>
                      )}
                      <button onClick={() => setShowLearnPanel(!showLearnPanel)}
                        className="px-3 py-1.5 text-xs rounded-lg border border-purple-300 text-purple-600 hover:bg-purple-100">
                        {showLearnPanel ? "收起" : "展开详情"}
                      </button>
                      <button onClick={handleStyleLearn} disabled={styleLearning}
                        className={`px-4 py-1.5 text-xs rounded-lg font-medium text-white ${styleLearning ? "bg-gray-400 cursor-not-allowed" : "bg-gradient-to-r from-purple-500 to-indigo-600 hover:from-purple-600 hover:to-indigo-700"}`}>
                        {styleLearning ? "学习中..." : "🚀 开始学习"}
                      </button>
                    </div>
                  </div>

                  <p className="text-xs text-purple-600 mb-2">
                    自动抓取你的公众号历史文章 + 10个头部同行账号，AI深度分析风格后生成专属模版库
                  </p>

                  {showLearnPanel && (
                    <div className="mt-3">
                      {/* 学习进度 */}
                      {styleProgress.length > 0 && (
                        <div className="bg-white/70 rounded-lg p-3 mb-3 max-h-40 overflow-y-auto">
                          {styleProgress.map((msg, i) => (
                            <div key={i} className="text-xs text-gray-600 py-0.5 flex items-center gap-1">
                              <span className="text-purple-400">{i === styleProgress.length - 1 && styleLearning ? "⏳" : "✓"}</span>
                              {msg}
                            </div>
                          ))}
                        </div>
                      )}

                      {/* 风格分析摘要 */}
                      {styleAnalysesData.length > 0 && (
                        <div className="bg-white/70 rounded-lg p-3">
                          <h4 className="text-xs font-bold text-gray-700 mb-2">风格分析概览</h4>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                            {styleAnalysesData.map((sa: any, i: number) => (
                              <div key={i} className="text-xs p-2 rounded bg-gray-50 border border-gray-100">
                                <div className="font-medium text-gray-800">
                                  {sa.source === "self" ? "🏠" : "👥"} {sa.accountName}
                                  <span className="ml-1 text-gray-400">({sa.articleCount}篇)</span>
                                </div>
                                {sa.overallSummary && (
                                  <div className="text-gray-500 mt-1 line-clamp-2">{sa.overallSummary}</div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* 学习生成的模版 */}
                {learnedTpls.length > 0 && (
                  <div className="mb-6">
                    <h3 className="text-sm font-bold text-gray-700 mb-3 flex items-center gap-1">
                      <span>🎯</span> AI学习模版（基于风格分析生成）
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                      {learnedTpls.map((t) => {
                        const isSel = selectedTemplate === `learned:${t.id}`;
                        return (
                          <div key={t.id} onClick={() => handleSelectTemplate(`learned:${t.id}`)}
                            className={`bg-white rounded-xl border-2 p-5 cursor-pointer transition-all ${isSel ? "border-purple-500 shadow-lg" : "border-gray-200 hover:border-purple-300 hover:shadow-md"}`}>
                            <div className="flex items-center gap-3 mb-2">
                              <span className="text-2xl">{t.icon}</span>
                              <div className="flex-1">
                                <h3 className="font-bold text-gray-900">{t.name}</h3>
                                <p className="text-xs text-gray-500">{t.desc}</p>
                              </div>
                              <span className={`text-xs px-2 py-0.5 rounded-full ${t.source === "self_style" ? "bg-green-100 text-green-600" : t.source === "peer_style" ? "bg-blue-100 text-blue-600" : "bg-orange-100 text-orange-600"}`}>
                                {t.source === "self_style" ? "自己风格" : t.source === "peer_style" ? "同行风格" : "AI创新"}
                              </span>
                            </div>
                            {t.sourceAccount && (
                              <p className="text-xs text-gray-400 mb-2">参考: {t.sourceAccount}</p>
                            )}
                            {t.sampleTitle && (
                              <p className="text-xs text-purple-600 mb-2 italic">示例: {t.sampleTitle}</p>
                            )}
                            <div className="flex flex-wrap gap-1.5">
                              {t.sections.map((s: string, i: number) => (
                                <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-purple-50 text-purple-600">
                                  {i + 1}. {s}
                                </span>
                              ))}
                            </div>
                            {t.styleTags && t.styleTags.length > 0 && (
                              <div className="flex flex-wrap gap-1 mt-2">
                                {(t.styleTags as string[]).map((tag: string, i: number) => (
                                  <span key={i} className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">#{tag}</span>
                                ))}
                              </div>
                            )}
                            <div className="mt-3 text-right">
                              <span className={`text-sm font-medium ${isSel ? "text-purple-600" : "text-gray-400"}`}>
                                {isSel ? "\u2713 已选择" : "点击选择 \u2192"}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* 内置模版 */}
                <h3 className="text-sm font-bold text-gray-700 mb-3 flex items-center gap-1">
                  <span>📋</span> 内置模版
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {ARTICLE_TEMPLATES.map((t) => {
                    const isSel = selectedTemplate === t.id;
                    return (
                      <div key={t.id} onClick={() => handleSelectTemplate(t.id)}
                        className={`bg-white rounded-xl border-2 p-5 cursor-pointer transition-all ${isSel ? "border-blue-500 shadow-lg" : "border-gray-200 hover:border-blue-300 hover:shadow-md"}`}>
                        <div className="flex items-center gap-3 mb-3">
                          <span className="text-2xl">{t.icon}</span>
                          <div>
                            <h3 className="font-bold text-gray-900">{t.name}</h3>
                            <p className="text-xs text-gray-500">{t.desc}</p>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {t.sections.map((s, i) => (
                            <span key={i} className="text-xs px-2 py-1 rounded-full bg-gray-100 text-gray-600">
                              {i + 1}. {s}
                            </span>
                          ))}
                        </div>
                        <div className="mt-3 text-right">
                          <span className={`text-sm font-medium ${isSel ? "text-blue-600" : "text-gray-400"}`}>
                            {isSel ? "\u2713 已选择" : "点击选择 \u2192"}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="bg-gray-50 rounded-lg border-2 border-dashed border-gray-300 p-8 text-center">
                <div className="text-3xl mb-3">{"\uD83C\uDFAC"}</div>
                <h3 className="text-base font-medium text-gray-600 mb-2">视频脚本生成（开发中）</h3>
                <button onClick={() => { setCompletedSteps((prev) => new Set([...prev, 4])); setCurrentStep(5); }}
                  className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700">
                  跳过，进入下一步
                </button>
              </div>
            )}
          </div>
        )}

        {/* ========== Step 6: AI创作图文 ========== */}
        {currentStep === 5 && (
          <div>
            <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
              <h2 className="text-lg font-bold text-gray-900 mb-1">
                {workflowType === "article" ? "第六步：AI创作图文文章" : "第六步：视频生成"}
              </h2>
              <p className="text-sm text-gray-500 mb-4">
                {workflowType === "article"
                  ? "AI根据关键词、标题、期刊数据、模版结构，生成专业公众号图文文章"
                  : "将脚本转换为视频内容"}
              </p>
              <ContextBar />

              {workflowType === "article" && !generatedArticle && (
                <div className="flex items-center gap-3">
                  <button onClick={handleGenerate} disabled={generating}
                    className={`px-6 py-2.5 rounded-lg text-sm font-medium text-white transition-all ${generating ? "bg-gray-400 cursor-not-allowed" : "bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 active:scale-95"}`}>
                    {generating ? "AI创作中..." : "\uD83D\uDD8A\uFE0F 开始AI创作"}
                  </button>
                  {selectedTemplate && (
                    <span className="text-xs text-gray-500">模版: {selectedTemplate.startsWith("learned:") ? (learnedTpls.find((t) => t.id === selectedTemplate.replace("learned:", ""))?.name || "学习模版") : (ARTICLE_TEMPLATES.find((t) => t.id === selectedTemplate)?.name)}</span>
                  )}
                </div>
              )}

              {generating && (
                <div className="mt-4 flex items-center gap-2 text-sm text-green-600">
                  <div className="w-4 h-4 border-2 border-green-500 border-t-transparent rounded-full animate-spin" />
                  DeepSeek AI 正在根据模版生成文章，预计15-30秒...
                </div>
              )}

              {generateError && (
                <div className="mt-4 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
                  {"\u274C"} {generateError}
                  <button onClick={handleGenerate} className="ml-2 underline">重试</button>
                </div>
              )}
            </div>

            {/* 生成结果 */}
            {generatedArticle && (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-medium text-gray-700">{"\uD83D\uDCDD"} 生成结果：</h3>
                  <div className="flex gap-2">
                    <button onClick={() => { navigator.clipboard.writeText(generatedArticle); }}
                      className="px-3 py-1.5 text-xs bg-white border border-gray-300 rounded-lg hover:bg-gray-50">
                      {"\uD83D\uDCCB"} 复制全文
                    </button>
                    <button onClick={handleGenerate}
                      className="px-3 py-1.5 text-xs bg-white border border-gray-300 rounded-lg hover:bg-gray-50">
                      {"\uD83D\uDD04"} 重新生成
                    </button>
                    <button onClick={() => { setCompletedSteps((prev) => new Set([...prev, 5])); setCurrentStep(6); }}
                      className="px-3 py-1.5 text-xs bg-green-600 text-white rounded-lg hover:bg-green-700">
                      {"\u2713"} 满意，下一步
                    </button>
                  </div>
                </div>
                <div className="bg-white rounded-xl border border-gray-200 p-6 prose prose-sm max-w-none">
                  {generatedArticle.split("\n").map((line, i) => {
                    if (line.startsWith("## ")) return <h2 key={i} className="text-lg font-bold text-gray-900 mt-5 mb-2">{line.replace("## ", "")}</h2>;
                    if (line.startsWith("### ")) return <h3 key={i} className="text-base font-bold text-gray-800 mt-4 mb-1">{line.replace("### ", "")}</h3>;
                    if (line.startsWith("# ")) return <h1 key={i} className="text-xl font-bold text-gray-900 mt-4 mb-3">{line.replace("# ", "")}</h1>;
                    if (line.startsWith("---")) return <hr key={i} className="my-4 border-gray-200" />;
                    if (line.startsWith("- ") || line.startsWith("* ")) return <li key={i} className="text-gray-700 ml-4">{line.replace(/^[-*]\s/, "")}</li>;
                    const imgMatch = line.match(/^!\[([^\]]*)\]\((.+)\)/);
                    if (imgMatch) return <div key={i} className="my-3 text-center"><img src={imgMatch[2]} alt={imgMatch[1]} className="inline-block max-w-full rounded-lg border border-gray-200 shadow-sm" style={{ maxHeight: 200 }} /><p className="text-xs text-gray-400 mt-1">{imgMatch[1]}</p></div>;
                    if (line.trim() === "") return <div key={i} className="h-2" />;
                    return <p key={i} className="text-gray-700 leading-relaxed mb-2">{line}</p>;
                  })}
                </div>
              </div>
            )}

            {workflowType === "video" && (
              <div className="bg-gray-50 rounded-lg border-2 border-dashed border-gray-300 p-8 text-center">
                <div className="text-3xl mb-3">{"\uD83C\uDFA5"}</div>
                <h3 className="text-base font-medium text-gray-600 mb-2">AI视频生成（开发中）</h3>
                <button onClick={() => { setCompletedSteps((prev) => new Set([...prev, 5])); setCurrentStep(6); }}
                  className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700">跳过 →</button>
              </div>
            )}
          </div>
        )}

        {/* ========== Step 7: 核对准确度 ========== */}
        {currentStep === 6 && (
          <div>
            <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
              <h2 className="text-lg font-bold text-gray-900 mb-1">第七步：核对信息准确度</h2>
              <p className="text-sm text-gray-500 mb-4">AI提取文章中的期刊数据，与LetPub数据库交叉验证，标记不准确的信息</p>

              <div className="flex flex-wrap items-center gap-3">
                <button onClick={handleVerify} disabled={verifying}
                  className={`px-5 py-2 rounded-lg text-sm font-medium text-white transition-all ${verifying ? "bg-gray-400 cursor-not-allowed" : "bg-blue-600 hover:bg-blue-700 active:scale-95"}`}>
                  {verifying ? "核对中..." : "\uD83D\uDD0D 重新核对"}
                </button>
                {verifyResult && verifyResult.summary.failedChecks > 0 && (
                  <button onClick={handleAutoFix} disabled={autoFixing}
                    className={`px-5 py-2 rounded-lg text-sm font-medium text-white transition-all ${autoFixing ? "bg-gray-400 cursor-not-allowed" : "bg-orange-500 hover:bg-orange-600 active:scale-95"}`}>
                    {autoFixing ? "AI修正中..." : `\u{1F527} 自动修正 (${verifyResult.summary.failedChecks}项错误)`}
                  </button>
                )}
                <button onClick={handleQualityScore} disabled={scoringQuality}
                  className={`px-5 py-2 rounded-lg text-sm font-medium text-white transition-all ${scoringQuality ? "bg-gray-400 cursor-not-allowed" : "bg-purple-600 hover:bg-purple-700 active:scale-95"}`}>
                  {scoringQuality ? "评分中..." : "\uD83D\uDCCA 质量评分"}
                </button>
                {verifyResult && (
                  <button onClick={() => { setCompletedSteps((prev) => new Set([...prev, 6])); setCurrentStep(7); }}
                    className="px-5 py-2 rounded-lg text-sm font-medium text-white bg-green-600 hover:bg-green-700 active:scale-95">
                    确认，进入下一步 {"\u2192"}
                  </button>
                )}
              </div>

              {verifying && (
                <div className="mt-4 flex items-center gap-2 text-sm text-blue-600">
                  <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                  AI正在提取文章中的期刊数据并与数据库交叉验证...
                </div>
              )}
            </div>

            {/* 核对结果 */}
            {verifyResult && (
              <div>
                {/* 总分 */}
                <div className={`rounded-xl border-2 p-5 mb-6 ${
                  verifyResult.summary.accuracy >= 80 ? "bg-green-50 border-green-300" :
                  verifyResult.summary.accuracy >= 50 ? "bg-yellow-50 border-yellow-300" :
                  "bg-red-50 border-red-300"
                }`}>
                  <div className="flex items-center gap-4">
                    <div className="text-4xl font-bold">
                      {verifyResult.summary.accuracy >= 80 ? "\u2705" : verifyResult.summary.accuracy >= 50 ? "\u26A0\uFE0F" : "\u274C"}
                    </div>
                    <div>
                      <div className="text-2xl font-bold text-gray-900">准确率 {verifyResult.summary.accuracy}%</div>
                      <div className="text-sm text-gray-600">
                        共核对 {verifyResult.summary.totalChecks} 项数据：{verifyResult.summary.passedChecks} 项正确，{verifyResult.summary.failedChecks} 项需修正
                      </div>
                    </div>
                  </div>
                </div>

                {/* 逐刊核对详情 */}
                <div className="space-y-4">
                  {verifyResult.results.map((r: any, idx: number) => (
                    <div key={idx} className="bg-white rounded-xl border border-gray-200 p-4">
                      <div className="flex items-center gap-2 mb-3">
                        <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs text-white font-bold ${
                          r.found ? (r.checks.every((c: any) => c.match) ? "bg-green-500" : "bg-yellow-500") : "bg-red-500"
                        }`}>
                          {r.found ? (r.checks.every((c: any) => c.match) ? "\u2713" : "!") : "?"}
                        </span>
                        <h4 className="font-bold text-gray-900 text-sm">{r.journalName}</h4>
                        {!r.found && <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-600">数据库未收录</span>}
                      </div>
                      {r.checks.length > 0 && (
                        <div className="overflow-hidden rounded-lg border border-gray-200">
                          <table className="w-full text-sm">
                            <thead className="bg-gray-50">
                              <tr>
                                <th className="text-left px-3 py-2 text-gray-600 font-medium">核对项</th>
                                <th className="text-left px-3 py-2 text-gray-600 font-medium">文章中</th>
                                <th className="text-left px-3 py-2 text-gray-600 font-medium">数据库</th>
                                <th className="text-center px-3 py-2 text-gray-600 font-medium">结果</th>
                              </tr>
                            </thead>
                            <tbody>
                              {r.checks.map((c: any, ci: number) => (
                                <tr key={ci} className={`border-t border-gray-100 ${c.match ? "" : "bg-red-50"}`}>
                                  <td className="px-3 py-2 text-gray-700">{c.field}</td>
                                  <td className="px-3 py-2 text-gray-700">{c.articleValue}</td>
                                  <td className="px-3 py-2 text-gray-700 font-medium">{c.dbValue}</td>
                                  <td className="px-3 py-2 text-center">
                                    {c.match
                                      ? <span className="text-green-600 font-bold">{"\u2713"}</span>
                                      : <span className="text-red-600 font-bold">{"\u2717"}</span>
                                    }
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* 自动修正结果 */}
                {autoFixResult && (
                  <div className={`mt-6 rounded-xl border-2 p-5 ${autoFixResult.fixCount > 0 ? "bg-orange-50 border-orange-300" : "bg-green-50 border-green-300"}`}>
                    <div className="flex items-center gap-3 mb-3">
                      <div className="text-2xl">{autoFixResult.fixCount > 0 ? "\u{1F527}" : "\u2705"}</div>
                      <div>
                        <h4 className="font-bold text-gray-900">
                          {autoFixResult.fixCount > 0 ? `已自动修正 ${autoFixResult.fixCount} 处` : "无需修正"}
                        </h4>
                        <p className="text-sm text-gray-600">
                          AI审核信心分: {autoFixResult.aiReview.confidence}%
                          {autoFixResult.aiReview.confidence >= 80 ? " — 内容可靠" : " — 建议人工复查"}
                        </p>
                      </div>
                    </div>

                    {/* 修正明细 */}
                    {autoFixResult.fixes.length > 0 && (
                      <div className="overflow-hidden rounded-lg border border-orange-200 mb-3">
                        <table className="w-full text-sm">
                          <thead className="bg-orange-100">
                            <tr>
                              <th className="text-left px-3 py-2 text-gray-600 font-medium">修正项</th>
                              <th className="text-left px-3 py-2 text-gray-600 font-medium">期刊</th>
                              <th className="text-left px-3 py-2 text-gray-600 font-medium">原文</th>
                              <th className="text-left px-3 py-2 text-gray-600 font-medium">修正为</th>
                            </tr>
                          </thead>
                          <tbody>
                            {autoFixResult.fixes.map((f, idx) => (
                              <tr key={idx} className="border-t border-orange-100">
                                <td className="px-3 py-2 text-gray-700">{f.field}</td>
                                <td className="px-3 py-2 text-gray-700">{f.journal}</td>
                                <td className="px-3 py-2 text-red-600 line-through">{f.from}</td>
                                <td className="px-3 py-2 text-green-700 font-medium">{f.to}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {/* AI审查意见 */}
                    {autoFixResult.aiReview.issues.length > 0 && (
                      <div className="bg-white rounded-lg p-3 border border-orange-200">
                        <h5 className="text-sm font-bold text-gray-700 mb-2">AI审查发现的问题：</h5>
                        <div className="space-y-1">
                          {autoFixResult.aiReview.issues.map((issue, i) => (
                            <p key={i} className="text-sm text-orange-700">• {issue}</p>
                          ))}
                        </div>
                        {autoFixResult.aiReview.suggestions.length > 0 && (
                          <div className="mt-2 pt-2 border-t border-orange-100">
                            <h5 className="text-sm font-bold text-gray-700 mb-1">改进建议：</h5>
                            {autoFixResult.aiReview.suggestions.map((s, i) => (
                              <p key={i} className="text-sm text-blue-700">• {s}</p>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    <p className="mt-3 text-xs text-gray-500">文章内容已自动更新为修正后版本，可在下一步"一键发布"中编辑预览</p>
                  </div>
                )}

                {/* 质量评分面板 */}
                {qualityScore && (
                  <div className="mt-6 bg-white rounded-xl border border-gray-200 p-5">
                    <div className="flex items-center gap-3 mb-4">
                      <div className="text-2xl">{"\uD83D\uDCCA"}</div>
                      <div className="flex-1">
                        <h4 className="font-bold text-gray-900">文章质量评分</h4>
                        <p className="text-sm text-gray-500">基于可读性、SEO、内容结构三维度评估</p>
                      </div>
                      <div className={`px-4 py-2 rounded-xl text-center ${
                        qualityScore.publishReady ? "bg-green-100 border-2 border-green-300" : "bg-yellow-100 border-2 border-yellow-300"
                      }`}>
                        <div className={`text-2xl font-bold ${qualityScore.publishReady ? "text-green-700" : "text-yellow-700"}`}>
                          {qualityScore.overall}
                        </div>
                        <div className={`text-xs font-medium ${qualityScore.publishReady ? "text-green-600" : "text-yellow-600"}`}>
                          {qualityScore.publishReady ? "\u2705 发布就绪" : "\u26A0\uFE0F 建议优化"}
                        </div>
                      </div>
                    </div>

                    {/* 三维度评分条 */}
                    <div className="grid grid-cols-3 gap-4 mb-4">
                      {[
                        { label: "可读性", score: qualityScore.dimensions.readability.score, color: "blue" },
                        { label: "SEO优化", score: qualityScore.dimensions.seo.score, color: "green" },
                        { label: "内容结构", score: qualityScore.dimensions.structure.score, color: "purple" },
                      ].map((dim) => (
                        <div key={dim.label} className="bg-gray-50 rounded-lg p-3">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-sm font-medium text-gray-700">{dim.label}</span>
                            <span className={`text-sm font-bold ${
                              dim.score >= 80 ? "text-green-600" : dim.score >= 60 ? "text-yellow-600" : "text-red-600"
                            }`}>{dim.score}分</span>
                          </div>
                          <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full transition-all duration-500 ${
                              dim.score >= 80 ? "bg-green-500" : dim.score >= 60 ? "bg-yellow-500" : "bg-red-500"
                            }`} style={{ width: `${dim.score}%` }} />
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* SEO关键词密度 */}
                    {Object.keys(qualityScore.dimensions.seo.details.keywordDensity).length > 0 && (
                      <div className="bg-gray-50 rounded-lg p-3 mb-4">
                        <h5 className="text-sm font-medium text-gray-700 mb-2">关键词出现次数</h5>
                        <div className="flex flex-wrap gap-2">
                          {Object.entries(qualityScore.dimensions.seo.details.keywordDensity).map(([kw, count]) => (
                            <span key={kw} className={`text-xs px-2 py-1 rounded-full ${
                              count >= 2 ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                            }`}>
                              {kw}: {count}次 {count >= 2 ? "\u2713" : "\u2717"}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* 结构检查 */}
                    <div className="bg-gray-50 rounded-lg p-3 mb-4">
                      <h5 className="text-sm font-medium text-gray-700 mb-2">结构检查</h5>
                      <div className="grid grid-cols-2 gap-2">
                        {[
                          { label: "导语/开头", ok: qualityScore.dimensions.structure.details.hasIntro },
                          { label: "总结/结尾", ok: qualityScore.dimensions.structure.details.hasConclusion },
                          { label: "列表使用", ok: qualityScore.dimensions.structure.details.hasList },
                          { label: "重点加粗", ok: qualityScore.dimensions.structure.details.hasEmphasis },
                        ].map((item) => (
                          <div key={item.label} className="flex items-center gap-2 text-sm">
                            <span className={item.ok ? "text-green-600" : "text-red-500"}>{item.ok ? "\u2713" : "\u2717"}</span>
                            <span className={item.ok ? "text-gray-700" : "text-red-600"}>{item.label}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* 改进建议 */}
                    {qualityScore.allTips.length > 0 && (
                      <div className="bg-yellow-50 rounded-lg p-3 border border-yellow-200">
                        <h5 className="text-sm font-bold text-yellow-800 mb-2">改进建议 ({qualityScore.allTips.length})</h5>
                        <div className="space-y-1">
                          {qualityScore.allTips.map((tip, i) => (
                            <p key={i} className="text-sm text-yellow-700">• {tip}</p>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ========== Step 8: 一键发布 ========== */}
        {currentStep === 7 && (
          <div>
            <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
              <h2 className="text-lg font-bold text-gray-900 mb-1">第八步：一键发布</h2>
              <p className="text-sm text-gray-500 mb-4">预览文章、编辑调整，然后导出或发布到各平台</p>

              {/* 操作按钮栏 */}
              <div className="flex flex-wrap items-center gap-3 mb-4">
                <button onClick={() => setIsEditing(!isEditing)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${isEditing ? "bg-yellow-500 text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"}`}>
                  {isEditing ? "\u270F\uFE0F \u4FDD\u5B58\u7F16\u8F91" : "\u270F\uFE0F \u7F16\u8F91\u6587\u7AE0"}
                </button>
                <button onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(editableArticle || generatedArticle);
                    setCopySuccess(true);
                    setTimeout(() => setCopySuccess(false), 2000);
                  } catch { /* fallback */ }
                }}
                  className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-50 text-blue-700 hover:bg-blue-100 transition-all">
                  {copySuccess ? "\u2705 \u5DF2\u590D\u5236" : "\uD83D\uDCCB \u590D\u5236\u6587\u672C"}
                </button>
                <button onClick={async () => {
                  setExporting(true);
                  try {
                    const res = await api.post<any>("/workflow/export-html", {
                      content: editableArticle || generatedArticle,
                      title: selectedTitle,
                    });
                    if (res.data?.html) {
                      setExportedHtml(res.data.html);
                      // 自动下载HTML文件
                      const blob = new Blob([res.data.html], { type: "text/html;charset=utf-8" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `${selectedTitle || "BossMate\u6587\u7AE0"}.html`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }
                  } catch (err) {
                    console.error("导出失败", err);
                  } finally {
                    setExporting(false);
                  }
                }}
                  disabled={exporting}
                  className="px-4 py-2 rounded-lg text-sm font-medium bg-green-50 text-green-700 hover:bg-green-100 transition-all disabled:opacity-50">
                  {exporting ? "\u5BFC\u51FA\u4E2D..." : "\uD83D\uDCC4 \u5BFC\u51FAHTML\uFF08\u516C\u4F17\u53F7\u6392\u7248\uFF09"}
                </button>
              </div>

              {/* 编辑模式 */}
              {isEditing ? (
                <textarea
                  value={editableArticle}
                  onChange={(e) => setEditableArticle(e.target.value)}
                  className="w-full h-96 p-4 text-sm text-gray-800 border border-yellow-300 rounded-lg bg-yellow-50 focus:outline-none focus:ring-2 focus:ring-yellow-400 font-mono leading-relaxed resize-y"
                  placeholder="\u7F16\u8F91\u6587\u7AE0\u5185\u5BB9..."
                />
              ) : (
                /* 预览模式 */
                <div className="border border-gray-200 rounded-lg bg-white p-6 max-h-[500px] overflow-y-auto">
                  <div className="prose prose-sm max-w-none">
                    {(editableArticle || generatedArticle).split("\n").map((line, i) => {
                      const trimmed = line.trim();
                      if (!trimmed) return <div key={i} className="h-3" />;
                      if (trimmed.startsWith("# ")) return <h1 key={i} className="text-xl font-bold text-gray-900 mt-5 mb-3 text-center">{trimmed.slice(2)}</h1>;
                      if (trimmed.startsWith("## ")) return <h2 key={i} className="text-lg font-bold text-gray-800 mt-4 mb-2 border-b-2 border-green-500 pb-1 inline-block">{trimmed.slice(3)}</h2>;
                      if (trimmed.startsWith("### ")) return <h3 key={i} className="text-base font-bold text-gray-700 mt-3 mb-2 pl-3 border-l-4 border-green-500">{trimmed.slice(4)}</h3>;
                      if (trimmed.startsWith("> ")) return <blockquote key={i} className="border-l-3 border-green-400 pl-4 py-2 my-2 bg-gray-50 text-gray-600 text-sm italic rounded-r">{trimmed.slice(2)}</blockquote>;
                      if (trimmed.startsWith("- ")) return <p key={i} className="pl-5 my-1 text-sm text-gray-700 leading-relaxed">{"\u2022 "}{trimmed.slice(2)}</p>;
                      if (/^\d+\. /.test(trimmed)) return <p key={i} className="pl-5 my-1 text-sm text-gray-700 leading-relaxed">{trimmed}</p>;
                      const imgMatch = trimmed.match(/^!\[([^\]]*)\]\((.+)\)/);
                      if (imgMatch) return <div key={i} className="my-4 text-center"><img src={imgMatch[2]} alt={imgMatch[1]} className="inline-block max-w-full rounded-lg border border-gray-200 shadow-sm" style={{ maxHeight: 200 }} /><p className="text-xs text-gray-400 mt-1">{imgMatch[1]}</p></div>;
                      return <p key={i} className="text-sm text-gray-700 leading-relaxed my-2 indent-8">{trimmed.replace(/\*\*(.+?)\*\*/g, (_, t) => t)}</p>;
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* 微信公众号发布 */}
            <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-bold text-gray-900">{"\uD83D\uDCE2"} 发布到平台</h3>
                <Link to="/settings" className="text-xs text-blue-600 hover:underline">{"\u2699\uFE0F"} 公众号设置</Link>
              </div>

              {/* 微信公众号 - 核心发布渠道 */}
              <div className={`p-4 rounded-xl border-2 mb-4 ${
                wechatStatus === "verified" ? "border-green-300 bg-green-50" :
                wechatStatus === "configured" ? "border-amber-300 bg-amber-50" :
                "border-gray-200 bg-gray-50"
              }`}>
                <div className="flex items-center gap-3 mb-3">
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center text-xl ${
                    wechatStatus === "verified" ? "bg-green-500" : wechatStatus === "configured" ? "bg-amber-500" : "bg-gray-400"
                  }`}>{"\uD83D\uDCF1"}</div>
                  <div className="flex-1">
                    <div className="font-bold text-gray-900 text-sm">微信公众号</div>
                    <div className="text-xs text-gray-500">
                      {wechatStatus === "loading" && "检查配置中..."}
                      {wechatStatus === "verified" && "\u2705 已验证，可直接发布到草稿箱"}
                      {wechatStatus === "configured" && "\u26A0\uFE0F 已配置但未验证通过，请先到设置页完成IP白名单配置"}
                      {wechatStatus === "none" && "未配置，请先设置AppID/AppSecret"}
                    </div>
                  </div>
                  {wechatStatus === "verified" && (
                    <button
                      onClick={handleWechatPublish}
                      disabled={publishing || !!publishResult?.ok}
                      className={`px-5 py-2 rounded-lg text-sm font-medium text-white transition-all ${
                        publishResult?.ok ? "bg-green-400 cursor-not-allowed" : publishing ? "bg-gray-400 cursor-not-allowed" : "bg-green-600 hover:bg-green-700 active:scale-95"
                      }`}
                    >
                      {publishResult?.ok ? "\u2705 \u5DF2\u53D1\u5E03" : publishing ? "\u53D1\u5E03\u4E2D..." : "\uD83D\uDE80 \u53D1\u5E03\u5230\u8349\u7A3F\u7BB1"}
                    </button>
                  )}
                  {wechatStatus === "configured" && (
                    <Link to="/settings" className="px-4 py-2 rounded-lg text-sm font-medium bg-amber-500 text-white hover:bg-amber-600">完成验证</Link>
                  )}
                  {wechatStatus === "none" && (
                    <Link to="/settings" className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700">去配置</Link>
                  )}
                </div>
                {wechatStatus === "configured" && (
                  <div className="p-3 rounded-lg bg-amber-100 text-amber-700 text-xs">
                    需要在微信公众平台的IP白名单中添加 <code className="px-1 py-0.5 bg-amber-200 rounded font-mono font-bold">106.53.163.120</code>，然后到设置页重新验证
                  </div>
                )}
                {publishResult && (
                  <div className={`p-3 rounded-lg text-sm mt-2 ${publishResult.ok ? "bg-green-100 text-green-700" : "bg-red-50 text-red-600"}`}>
                    {publishResult.msg}
                    {publishResult.ok && (
                      <p className="text-xs mt-1 text-green-600">请登录微信公众平台 → 内容管理 → 草稿箱 查看并确认发布</p>
                    )}
                  </div>
                )}
              </div>

              {/* 多平台一键发布 */}
              {platformAccountsLoading ? (
                <div className="flex items-center gap-2 text-sm text-gray-500 py-3">
                  <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                  加载平台账号中...
                </div>
              ) : platformAccounts.filter((a) => a.platform !== "wechat").length === 0 ? (
                <div className="p-4 rounded-lg border border-dashed border-gray-300 text-center">
                  <p className="text-sm text-gray-500 mb-2">暂无其他平台账号</p>
                  <Link to="/accounts" className="text-sm text-blue-600 hover:underline">前往添加百家号/头条号/知乎/小红书账号</Link>
                </div>
              ) : (
                <div className="space-y-3">
                  {(() => {
                    const platformCfg: Record<string, { name: string; icon: string }> = {
                      baijiahao: { name: "百家号", icon: "\uD83D\uDCDD" },
                      toutiao: { name: "头条号", icon: "\uD83D\uDCF0" },
                      zhihu: { name: "知乎", icon: "\uD83D\uDCA1" },
                      xiaohongshu: { name: "小红书", icon: "\uD83D\uDCD5" },
                    };
                    const grouped = new Map<string, typeof platformAccounts>();
                    for (const acc of platformAccounts) {
                      if (acc.platform === "wechat") continue; // 微信已单独处理
                      if (!grouped.has(acc.platform)) grouped.set(acc.platform, []);
                      grouped.get(acc.platform)!.push(acc);
                    }
                    return Array.from(grouped.entries()).map(([platform, accs]) => {
                      const cfg = platformCfg[platform] || { name: platform, icon: "\uD83C\uDF10" };
                      const allIds = accs.map((a) => a.id);
                      const allSelected = allIds.every((id) => selectedPlatformIds.includes(id));
                      return (
                        <div key={platform} className={`p-4 rounded-xl border-2 transition-all ${
                          allSelected ? "border-green-300 bg-green-50" : "border-gray-200 bg-gray-50"
                        }`}>
                          <div className="flex items-center gap-3 mb-2">
                            <input type="checkbox" checked={allSelected} onChange={() => togglePlatformGroup(platform)}
                              className="w-4 h-4 rounded border-gray-300 cursor-pointer" />
                            <span className="text-xl">{cfg.icon}</span>
                            <span className="font-bold text-gray-900 text-sm">{cfg.name}</span>
                            <span className="text-xs text-gray-400">({accs.length}个账号)</span>
                          </div>
                          <div className="ml-7 space-y-1.5">
                            {accs.map((acc) => (
                              <label key={acc.id} className="flex items-center gap-2 cursor-pointer">
                                <input type="checkbox" checked={selectedPlatformIds.includes(acc.id)}
                                  onChange={() => togglePlatformAccount(acc.id)}
                                  className="w-3.5 h-3.5 rounded border-gray-300 cursor-pointer" />
                                <span className="text-sm text-gray-700">{acc.accountName}</span>
                                <span className={`text-xs px-1.5 py-0.5 rounded ${
                                  acc.isVerified ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"
                                }`}>
                                  {acc.isVerified ? "\u2705 已验证" : "\u26A0\uFE0F 待验证"}
                                </span>
                              </label>
                            ))}
                          </div>
                        </div>
                      );
                    });
                  })()}

                  {/* 一键发布按钮 */}
                  <div className="flex items-center gap-3 pt-2">
                    <button
                      onClick={handleMultiPublish}
                      disabled={multiPublishing || selectedPlatformIds.length === 0}
                      className={`px-6 py-2.5 rounded-lg text-sm font-medium text-white transition-all ${
                        multiPublishing || selectedPlatformIds.length === 0
                          ? "bg-gray-400 cursor-not-allowed"
                          : "bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 active:scale-95"
                      }`}
                    >
                      {multiPublishing ? "\u53D1\u5E03\u4E2D..." : `\uD83D\uDE80 一键发布到 ${selectedPlatformIds.length} 个账号`}
                    </button>
                    {selectedPlatformIds.length === 0 && !multiPublishing && (
                      <span className="text-xs text-gray-400">请勾选要发布的账号</span>
                    )}
                  </div>

                  {/* 发布结果 */}
                  {multiPublishResults.length > 0 && (
                    <div className="space-y-2 pt-2">
                      {multiPublishResults.map((r) => (
                        <div key={r.accountId} className={`text-sm p-2.5 rounded-lg ${
                          r.success ? "bg-green-100 text-green-700" : "bg-red-50 text-red-600"
                        }`}>
                          {r.success ? "\u2705" : "\u274C"} {r.accountName}：{r.success ? "发布成功" : (r.error || r.message || "发布失败")}
                        </div>
                      ))}
                    </div>
                  )}
                  {multiPublishMsg && (
                    <p className={`text-sm pt-1 ${multiPublishMsg.includes("成功") ? "text-green-700" : "text-red-600"}`}>
                      {multiPublishMsg}
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* 流程总结 */}
            <div className="bg-gradient-to-r from-green-50 to-blue-50 rounded-xl border border-green-200 p-5">
              <div className="flex items-center gap-3 mb-3">
                <div className="text-2xl">{"\uD83C\uDF89"}</div>
                <div>
                  <h3 className="text-base font-bold text-gray-900">\u5DE5\u4F5C\u6D41\u5B8C\u6210\uFF01</h3>
                  <p className="text-sm text-gray-500">\u672C\u6B21\u5171\u5B8C\u6210 8 \u4E2A\u6B65\u9AA4\uFF0C\u5DF2\u751F\u6210\u4E13\u4E1A\u56FE\u6587\u6587\u7AE0</p>
                </div>
              </div>
              <div className="grid grid-cols-4 gap-2 mb-4">
                {[
                  { label: "\u5173\u952E\u8BCD", value: selectedCluster?.keywords?.length || 0 },
                  { label: "\u53C2\u8003\u671F\u520A", value: selectedJournals.size },
                  { label: "\u6838\u5BF9\u51C6\u786E\u7387", value: verifyResult?.summary?.accuracy ? `${verifyResult.summary.accuracy}%` : "N/A" },
                  { label: "\u8D28\u91CF\u8BC4\u5206", value: qualityScore ? `${qualityScore.overall}分` : "N/A" },
                ].map((s, i) => (
                  <div key={i} className="text-center p-2 bg-white/70 rounded-lg">
                    <div className="text-lg font-bold text-green-700">{s.value}</div>
                    <div className="text-xs text-gray-500">{s.label}</div>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-3">
                <Link to="/" className="px-5 py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700 font-medium">{"\uD83C\uDFE0"} \u8FD4\u56DE\u9996\u9875</Link>
                <Link to={`/workflow/${workflowType}`} onClick={() => window.location.reload()} className="px-5 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 font-medium">{"\uD83D\uDD04"} \u518D\u6765\u4E00\u7BC7</Link>
              </div>
            </div>
          </div>
        )}

        {/* 底部导航 */}
        <div className="flex items-center justify-between mt-6 pt-4 border-t border-gray-200">
          <button onClick={() => setCurrentStep((s) => Math.max(0, s - 1))} disabled={currentStep === 0}
            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 disabled:opacity-30 disabled:cursor-not-allowed">
            {"\u2190"} 上一步
          </button>
          <div className="text-sm text-gray-400">{currentStep + 1} / {steps.length}</div>
          {currentStep < steps.length - 1 && completedSteps.has(currentStep) && (
            <button onClick={() => setCurrentStep((s) => s + 1)} className="px-4 py-2 text-sm text-blue-600 hover:text-blue-700 font-medium">下一步 {"\u2192"}</button>
          )}
          {currentStep === steps.length - 1 && (
            <Link to="/" className="px-4 py-2 text-sm text-green-600 hover:text-green-700 font-medium">返回首页</Link>
          )}
          {!completedSteps.has(currentStep) && currentStep < steps.length - 1 && (
            <span className="text-xs text-gray-400">完成当前步骤后可继续</span>
          )}
        </div>
      </div>
    </div>
  );
}
