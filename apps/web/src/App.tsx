import { Routes, Route, Navigate } from "react-router-dom";
import { useAuthStore } from "./hooks/useAuthStore";
import { ToastContainer } from "./components/Toast";
import { ErrorBoundary } from "./components/ErrorBoundary";
import ProtectedAdminRoute from "./components/ProtectedAdminRoute";

// 页面
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import ChatPage from "./pages/ChatPage";
import ContentPage from "./pages/ContentPage";
import ContentDetailPage from "./pages/ContentDetailPage";
import DashboardPage from "./pages/DashboardPage";
// 6-10 老韩拍板下线(审计3.1/3.2), 路由已注释
// import KeywordsPage from "./pages/KeywordsPage";
import WorkflowPage from "./pages/WorkflowPage";
import SettingsPage from "./pages/SettingsPage";
import AccountsPage from "./pages/AccountsPage";
// 6-10 老韩拍板下线(审计3.1/3.2), 路由已注释
// import TemplatesPage from "./pages/TemplatesPage";
import AdminJournalsAuditPage from "./pages/AdminJournalsAuditPage";
import BatchProgressPage from "./pages/BatchProgressPage";
// 6-10 老韩拍板下线(审计3.1/3.2), 路由已注释
// import KnowledgePage from "./pages/KnowledgePage";
// 6-10 老韩拍板下线(审计3.1/3.2), 路由已注释
// import DataDashboardPage from "./pages/DataDashboardPage";
// 6-10 老韩拍板下线(审计3.1/3.2), 路由已注释
// import SalesPage from "./pages/SalesPage";
import VideoCreationPage from "./pages/VideoCreationPage";
// 6-10 老韩拍板下线(审计3.1/3.2), 路由已注释
// import JournalsAdminPage from "./pages/JournalsAdminPage";
import JournalDetailPage from "./pages/JournalDetailPage";
import RecommendationFeedPage from "./pages/RecommendationFeedPage";
import TryPage from "./pages/TryPage";
import CostComparisonPage from "./pages/CostComparisonPage";
import ContentWorkbenchPage from "./pages/ContentWorkbenchPage";
import SalesRadarPage from "./pages/SalesRadarPage";
// 5-21 P3 全局 chat 抽屉 (mount 在登录后所有 protected 页可见)
import { useState } from "react";
import ChatFab from "./components/chat-drawer/ChatFab";
import ChatDrawer from "./components/chat-drawer/ChatDrawer";
// 6-11 施工包C2-a (审计2.5): 全站统一侧边栏 — 所有可达登录后页面都包 MainLayout
import MainLayout from "./components/layout/MainLayout";

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  // 5-21 P3 chat 抽屉全局 state (登录后所有 protected 页可触发)
  const [chatOpen, setChatOpen] = useState(false);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  return (
    <>
      <ToastContainer />
      {isAuthenticated && <ChatFab onClick={() => setChatOpen(true)} />}
      {isAuthenticated && <ChatDrawer open={chatOpen} onClose={() => setChatOpen(false)} />}
      <ErrorBoundary>
        <Routes>
      {/* 公开页面 */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/try" element={<TryPage />} />  {/* B.9 onboarding —公众号罐头 URL 落地 */}

      {/* 5-17 P0 反转 PR #134：/ 改回 DashboardPage (新 hero), RecommendationFeedPage 挪到 /recommendations.
          /home 保留 redirect 到 / 防老书签 404. P2 加 role-based routing 后, 运营登录会自动跳 /recommendations. */}
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <MainLayout>
              <DashboardPage />
            </MainLayout>
          </ProtectedRoute>
        }
      />
      {/* 5-18 P1: /workbench 是新主战场 (左 list + 中 preview + 右分发卡), 替代 /recommendations.
          /recommendations 保留 Navigate redirect 到 /workbench (防老书签 + 早期 P0 链接). */}
      <Route
        path="/workbench"
        element={
          <ProtectedRoute>
            <MainLayout>
              <ContentWorkbenchPage />
            </MainLayout>
          </ProtectedRoute>
        }
      />
      <Route path="/recommendations" element={<Navigate to="/workbench" replace />} />

      {/* 5-21 P3 销售雷达 (老板视角 hero + 5 tab + leads list) */}
      <Route
        path="/sales-radar"
        element={
          <ProtectedRoute>
            <MainLayout>
              <SalesRadarPage />
            </MainLayout>
          </ProtectedRoute>
        }
      />
      {/* /recommend-feed: 留 RecommendationFeedPage 后门 (调试/未来 role-based 路由复用), 不暴露 nav */}
      <Route
        path="/recommend-feed"
        element={
          <ProtectedRoute>
            <MainLayout>
              <RecommendationFeedPage />
            </MainLayout>
          </ProtectedRoute>
        }
      />
      <Route path="/home" element={<Navigate to="/" replace />} />

      {/* 工作流管线（图文/视频） */}
      <Route
        path="/workflow/:type"
        element={
          <ProtectedRoute>
            <MainLayout>
              <WorkflowPage />
            </MainLayout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/chat"
        element={
          <ProtectedRoute>
            <MainLayout>
              <ChatPage />
            </MainLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/chat/:conversationId"
        element={
          <ProtectedRoute>
            <MainLayout>
              <ChatPage />
            </MainLayout>
          </ProtectedRoute>
        }
      />
      {/* 6-10 老韩拍板下线(审计3.1/3.2), 代码保留可随时恢复 */}
      {/*
      <Route
        path="/keywords"
        element={
          <ProtectedRoute>
            <KeywordsPage />
          </ProtectedRoute>
        }
      />
      */}
      <Route
        path="/content"
        element={
          <ProtectedRoute>
            <MainLayout>
              <ContentPage />
            </MainLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/content/:id"
        element={
          <ProtectedRoute>
            <MainLayout>
              <ContentDetailPage />
            </MainLayout>
          </ProtectedRoute>
        }
      />

      {/* 6-10 老韩拍板下线(审计3.1/3.2), 代码保留可随时恢复 */}
      {/*
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <DataDashboardPage />
          </ProtectedRoute>
        }
      />
      */}

      {/* PR Q.2: 内容模板管理 admin UI */}
      {/* 6-10 老韩拍板下线(审计3.1/3.2), 代码保留可随时恢复 */}
      {/*
      <Route
        path="/templates"
        element={
          <ProtectedRoute>
            <TemplatesPage />
          </ProtectedRoute>
        }
      />
      */}

      {/* PR 2 (5-9 早): 期刊数据审计页 (admin only) */}
      <Route
        path="/admin/journals/audit"
        element={
          <ProtectedAdminRoute>
            <MainLayout>
              <AdminJournalsAuditPage />
            </MainLayout>
          </ProtectedAdminRoute>
        }
      />

      {/* PR #119 (P4 frontend Day 2): 批量 csv 进度页 */}
      <Route
        path="/batch/:id"
        element={
          <ProtectedRoute>
            <MainLayout>
              <BatchProgressPage />
            </MainLayout>
          </ProtectedRoute>
        }
      />

      {/* 6-10 老韩拍板下线(审计3.1/3.2), 代码保留可随时恢复 */}
      {/*
      <Route
        path="/knowledge"
        element={
          <ProtectedRoute>
            <KnowledgePage />
          </ProtectedRoute>
        }
      />
      */}

      <Route
        path="/settings"
        element={
          <ProtectedRoute>
            <MainLayout>
              <SettingsPage />
            </MainLayout>
          </ProtectedRoute>
        }
      />

      {/* 5-16 PR: 成本/工时对比 (5-22 demo 老板演示页) */}
      <Route
        path="/cost-comparison"
        element={
          <ProtectedRoute>
            <MainLayout>
              <CostComparisonPage />
            </MainLayout>
          </ProtectedRoute>
        }
      />

      {/* 6-10 老韩拍板下线(审计3.1/3.2), 代码保留可随时恢复 */}
      {/*
      {import.meta.env.VITE_SALES_ENABLED === "true" && (
        <Route
          path="/sales"
          element={
            <ProtectedRoute>
              <SalesPage />
            </ProtectedRoute>
          }
        />
      )}
      */}

      <Route
        path="/video/create"
        element={
          <ProtectedRoute>
            <MainLayout>
              <VideoCreationPage />
            </MainLayout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/accounts"
        element={
          <ProtectedRoute>
            <MainLayout>
              <AccountsPage />
            </MainLayout>
          </ProtectedRoute>
        }
      />

      {/* Day 2 PR B: admin 期刊管理（owner/admin only） */}
      {/* 6-10 老韩拍板下线(审计3.1/3.2), 代码保留可随时恢复 */}
      {/*
      <Route
        path="/admin/journals"
        element={
          <ProtectedAdminRoute>
            <JournalsAdminPage />
          </ProtectedAdminRoute>
        }
      />
      */}

      {/* PR #125: 期刊详情页 — 修 audit 页 [👁️ 查看] 跳首页 bug */}
      <Route
        path="/journals/:id"
        element={
          <ProtectedRoute>
            <MainLayout>
              <JournalDetailPage />
            </MainLayout>
          </ProtectedRoute>
        }
      />

      {/* 404 */}
      <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ErrorBoundary>
    </>
  );
}
