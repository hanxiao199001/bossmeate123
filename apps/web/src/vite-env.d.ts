/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SALES_ENABLED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
