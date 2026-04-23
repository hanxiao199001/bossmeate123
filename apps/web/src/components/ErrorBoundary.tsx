import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** 自定义 fallback UI；传入时覆盖默认页面 */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** 出错时的回调，用于上报埋点/日志 */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * 顶层错误边界：拦截渲染期/生命周期里未捕获的异常，避免整个应用白屏。
 *
 * 使用：
 *   <ErrorBoundary>
 *     <Routes>...</Routes>
 *   </ErrorBoundary>
 *
 * 注意：React 错误边界无法捕获事件处理器、异步代码、SSR 中抛出的错误，
 * 这些需要在调用处显式 try/catch 或通过 window.onerror / unhandledrejection 上报。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary] caught render error:", error, info);
    this.props.onError?.(error, info);
  }

  private handleReset = (): void => {
    this.setState({ error: null });
  };

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) {
      return this.props.fallback(error, this.handleReset);
    }

    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0f172a",
          color: "#e2e8f0",
          padding: "24px",
          fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        }}
      >
        <div
          style={{
            maxWidth: 520,
            width: "100%",
            background: "#1e293b",
            borderRadius: 16,
            padding: 32,
            boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
            border: "1px solid #334155",
          }}
        >
          <div style={{ fontSize: 48, marginBottom: 16 }}>!</div>
          <h1 style={{ fontSize: 22, margin: "0 0 8px", color: "#f8fafc" }}>页面出错了</h1>
          <p style={{ color: "#94a3b8", lineHeight: 1.6, margin: "0 0 20px" }}>
            应用遇到了预期之外的错误。你可以尝试刷新页面，或返回首页继续使用。
          </p>
          <details
            style={{
              background: "#0f172a",
              padding: 12,
              borderRadius: 8,
              marginBottom: 20,
              color: "#cbd5e1",
              fontSize: 12,
            }}
          >
            <summary style={{ cursor: "pointer", color: "#94a3b8" }}>错误详情</summary>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                margin: "8px 0 0",
                fontFamily: "ui-monospace, SFMono-Regular, monospace",
              }}
            >
              {error.message}
              {error.stack ? "\n\n" + error.stack : ""}
            </pre>
          </details>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={this.handleReload}
              style={{
                flex: "1 1 140px",
                padding: "10px 16px",
                borderRadius: 8,
                border: "none",
                background: "#3b82f6",
                color: "#fff",
                fontSize: 14,
                cursor: "pointer",
                fontWeight: 500,
              }}
            >
              刷新页面
            </button>
            <button
              type="button"
              onClick={this.handleReset}
              style={{
                flex: "1 1 140px",
                padding: "10px 16px",
                borderRadius: 8,
                border: "1px solid #475569",
                background: "transparent",
                color: "#e2e8f0",
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              重试
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
