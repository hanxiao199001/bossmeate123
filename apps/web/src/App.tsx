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
import KeywordsPage from "./pages/KeywordsPage";
import WorkflowPage from "./pages/WorkflowPage";
import SettingsPage from "./pages/SettingsPage";
import AccountsPage from "./pages/AccountsPage";
import TemplatesPage from "./pages/TemplatesPage";
import AdminJournalsAuditPage from "./pages/AdminJournalsAuditPage";
import BatchProgressPage from "./pages/BatchProgressPage";
import KnowledgePage from "./pages/KnowledgePage";
import DataDashboardPage from "./pages/DataDashboardPage";
import SalesPage from "./pages/SalesPage";
import VideoCreationPage from "./pages/VideoCreationPage";
import JournalsAdminPage from "./pages/JournalsAdminPage";
import TryPage from "./pages/TryPage";

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <>
      <ToastContainer />
      <ErrorBoundary>
        <Routes>
      {/* 公开页面 */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/try" element={<TryPage />} />  {/* B.9 onboarding —公众号罐头 URL 落地 */}

      {/* 需要登录的页面 */}
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <DashboardPage />
          </ProtectedRoute>
        }
      />

      {/* 工作流管线（图文/视频） */}
      <Route
        path="/workflow/:type"
        element={
          <ProtectedRoute>
            <WorkflowPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/chat"
        element={
          <ProtectedRoute>
            <ChatPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/chat/:conversationId"
        element={
          <ProtectedRoute>
            <ChatPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/keywords"
        element={
          <ProtectedRoute>
            <KeywordsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/content"
        element={
          <ProtectedRoute>
            <ContentPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/content/:id"
        element={
          <ProtectedRoute>
            <ContentDetailPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <DataDashboardPage />
          </ProtectedRoute>
        }
      />

      {/* PR Q.2: 内容模板管理 admin UI */}
      <Route
        path="/templates"
        element={
          <ProtectedRoute>
            <TemplatesPage />
          </ProtectedRoute>
        }
      />

      {/* PR 2 (5-9 早): 期刊数据审计页 (admin only) */}
      <Route
        path="/admin/journals/audit"
        element={
          <ProtectedAdminRoute>
            <AdminJournalsAuditPage />
          </ProtectedAdminRoute>
        }
      />

      {/* PR #119 (P4 frontend Day 2): 批量 csv 进度页 */}
      <Route
        path="/batch/:id"
        element={
          <ProtectedRoute>
            <BatchProgressPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/knowledge"
        element={
          <ProtectedRoute>
            <KnowledgePage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/settings"
        element={
          <ProtectedRoute>
            <SettingsPage />
          </ProtectedRoute>
        }
      />

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

      <Route
        path="/video/create"
        element={
          <ProtectedRoute>
            <VideoCreationPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/accounts"
        element={
          <ProtectedRoute>
            <AccountsPage />
          </ProtectedRoute>
        }
      />

      {/* Day 2 PR B: admin 期刊管理（owner/admin only） */}
      <Route
        path="/admin/journals"
        element={
          <ProtectedAdminRoute>
            <JournalsAdminPage />
          </ProtectedAdminRoute>
        }
      />

      {/* 404 */}
      <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ErrorBoundary>
    </>
  );
}
