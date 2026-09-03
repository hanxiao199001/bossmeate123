/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SALES_ENABLED?: string;
  /** 微信公众平台 IP 白名单要填的服务器 IP（展示给客户） */
  readonly VITE_WECHAT_WHITELIST_IP?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
