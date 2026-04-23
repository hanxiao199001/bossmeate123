import React, { useState, useEffect } from "react";
import { useToastStore, ToastType } from "../stores/toastStore";

const toastColors: Record<ToastType, { bg: string; border: string; icon: string }> = {
  success: { bg: "#ecfdf5", border: "#10b981", icon: "✓" },
  error: { bg: "#fef2f2", border: "#ef4444", icon: "✕" },
  warning: { bg: "#fffbeb", border: "#f59e0b", icon: "!" },
  info: { bg: "#eff6ff", border: "#3b82f6", icon: "ℹ" },
};

const textColors: Record<ToastType, string> = {
  success: "#047857",
  error: "#991b1b",
  warning: "#92400e",
  info: "#1e40af",
};

interface ToastItemProps {
  id: string;
  type: ToastType;
  message: string;
  onRemove: (id: string) => void;
}

const ToastItem: React.FC<ToastItemProps> = ({ id, type, message, onRemove }) => {
  const [progress, setProgress] = useState(100);
  const colors = toastColors[type];
  const textColor = textColors[type];

  useEffect(() => {
    const interval = setInterval(() => {
      setProgress((prev) => Math.max(prev - 100 / 30, 0));
    }, 100);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (progress <= 0) {
      onRemove(id);
    }
  }, [progress, id, onRemove]);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "12px 16px",
        backgroundColor: colors.bg,
        border: `1px solid ${colors.border}`,
        borderRadius: "6px",
        boxShadow: "0 4px 6px rgba(0, 0, 0, 0.1)",
        animation: "slideIn 0.3s ease-out",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Progress bar */}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          height: "3px",
          width: `${progress}%`,
          backgroundColor: colors.border,
          transition: "width 0.1s linear",
        }}
      />

      {/* Icon */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "20px",
          height: "20px",
          borderRadius: "50%",
          backgroundColor: colors.border,
          color: "white",
          fontSize: "12px",
          fontWeight: "bold",
          flexShrink: 0,
        }}
      >
        {colors.icon}
      </div>

      {/* Message */}
      <span style={{ color: textColor, fontSize: "14px", flex: 1 }}>{message}</span>

      {/* Close button */}
      <button
        onClick={() => onRemove(id)}
        style={{
          background: "none",
          border: "none",
          color: textColor,
          fontSize: "18px",
          cursor: "pointer",
          padding: "0",
          flexShrink: 0,
          opacity: 0.7,
          transition: "opacity 0.2s",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
        onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.7")}
      >
        ×
      </button>
    </div>
  );
};

export const ToastContainer: React.FC = () => {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);

  return (
    <div
      style={{
        position: "fixed",
        top: "20px",
        right: "20px",
        zIndex: 10000,
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        pointerEvents: "auto",
        maxWidth: "400px",
      }}
    >
      <style>{`
        @keyframes slideIn {
          from {
            transform: translateX(400px);
            opacity: 0;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }
      `}</style>
      {toasts.map((toast) => (
        <ToastItem
          key={toast.id}
          id={toast.id}
          type={toast.type}
          message={toast.message}
          onRemove={removeToast}
        />
      ))}
    </div>
  );
};

// Public API for toast notifications
export const toast = {
  success: (message: string) => useToastStore.getState().addToast("success", message),
  error: (message: string) => useToastStore.getState().addToast("error", message),
  warning: (message: string) => useToastStore.getState().addToast("warning", message),
  info: (message: string) => useToastStore.getState().addToast("info", message),
};
