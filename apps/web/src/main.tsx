import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./styles/global.css";
// PR Q.4 D3：4 套模板 CSS 主题（class 选择器 .bm-template-{academic|marketing|popular|vertical}）
import "./styles/templates/academic.css";
import "./styles/templates/marketing.css";
import "./styles/templates/popular.css";
import "./styles/templates/vertical.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
