/**
 * 5-21 P0 — 全局 layout: 左 sidebar 160px + 右主内容区。
 * 包 ProtectedRoute children, demo 4 关键页 (/, /workbench, /sales-radar, /content/:id) 都用。
 * /cost-comparison + /chat 暂不迁, 老 nav 共存 (5-23 后单 PR 清理)。
 */
import type { ReactNode } from "react";
import Sidebar from "./Sidebar";

export interface MainLayoutProps {
  children: ReactNode;
}

export default function MainLayout({ children }: MainLayoutProps) {
  return (
    <div className="min-h-screen bg-[#F6F7F9]">
      <Sidebar />
      <main className="ml-52 min-h-screen">
        {children}
      </main>
    </div>
  );
}
