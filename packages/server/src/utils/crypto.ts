/**
 * 凭证加密/解密工具
 * 使用 AES-256-GCM 进行对称加密
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { env } from "../config/env.js";

const ALGORITHM = "aes-256-gcm";
const SALT = "bossmate-credentials-salt"; // 固定盐值用于密钥派生
const IV_LENGTH = 16; // GCM 初始化向量长度
const TAG_LENGTH = 16; // GCM 认证标签长度

/**
 * 从原始密钥派生 AES-256 密钥（32 字节）
 */
function deriveKey(rawKey: string): Buffer {
  return scryptSync(rawKey, SALT, 32);
}

/**
 * 加密凭证
 * @param plaintext 明文凭证（通常是 JSON 序列化的对象）
 * @param key 可选的自定义密钥，默认使用 CREDENTIALS_KEY 或 JWT_SECRET
 * @returns 加密后的数据，格式为 `iv:authTag:ciphertext`，都是十六进制
 */
export function encryptCredentials(plaintext: string, key?: string): string {
  const masterKey = key || env.CREDENTIALS_KEY || env.JWT_SECRET;

  if (!masterKey) {
    throw new Error(
      "无可用的加密密钥：请配置 CREDENTIALS_KEY 或 JWT_SECRET"
    );
  }

  // 生成随机 IV
  const iv = randomBytes(IV_LENGTH);

  // 派生密钥
  const derivedKey = deriveKey(masterKey);

  // 创建加密器
  const cipher = createCipheriv(ALGORITHM, derivedKey, iv);

  // 加密数据
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");

  // 获取认证标签
  const authTag = cipher.getAuthTag();

  // 组合格式：iv:authTag:ciphertext（都是十六进制）
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

/**
 * 解密凭证
 * @param encrypted 加密后的数据，格式为 `iv:authTag:ciphertext`
 * @param key 可选的自定义密钥，默认使用 CREDENTIALS_KEY 或 JWT_SECRET
 * @returns 解密后的明文凭证
 */
export function decryptCredentials(encrypted: string, key?: string): string {
  const masterKey = key || env.CREDENTIALS_KEY || env.JWT_SECRET;

  if (!masterKey) {
    throw new Error(
      "无可用的加密密钥：请配置 CREDENTIALS_KEY 或 JWT_SECRET"
    );
  }

  try {
    // 解析格式 iv:authTag:ciphertext
    const parts = encrypted.split(":");
    if (parts.length !== 3) {
      throw new Error("加密数据格式错误");
    }

    const iv = Buffer.from(parts[0], "hex");
    const authTag = Buffer.from(parts[1], "hex");
    const ciphertext = parts[2];

    // 派生密钥
    const derivedKey = deriveKey(masterKey);

    // 创建解密器
    const decipher = createDecipheriv(ALGORITHM, derivedKey, iv);

    // 设置认证标签以验证完整性
    decipher.setAuthTag(authTag);

    // 解密数据
    let decrypted = decipher.update(ciphertext, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch (error) {
    throw new Error(`解密凭证失败: ${error instanceof Error ? error.message : "未知错误"}`);
  }
}
