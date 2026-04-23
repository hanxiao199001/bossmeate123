import { describe, it, expect, vi, beforeEach } from "vitest";
import { encryptCredentials, decryptCredentials } from "../utils/crypto.js";

// Mock the env module to avoid needing real env variables
vi.mock("../config/env.js", () => ({
  env: {
    JWT_SECRET: "test-secret-key-for-encryption-purposes-12345",
    CREDENTIALS_KEY: "test-credentials-key-for-encryption-12345",
    LOG_LEVEL: "info",
    NODE_ENV: "test",
    PORT: 3000,
    API_PREFIX: "/api",
    ALLOWED_ORIGINS: "http://localhost:3000",
  },
}));

describe("Crypto Utils", () => {
  describe("encryptCredentials and decryptCredentials", () => {
    it("should encrypt and decrypt plaintext correctly", () => {
      const plaintext = "my-secret-api-key-12345";

      const encrypted = encryptCredentials(plaintext);
      expect(encrypted).toBeDefined();
      expect(typeof encrypted).toBe("string");
      expect(encrypted).toContain(":");

      const decrypted = decryptCredentials(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it("should handle JSON object encryption/decryption", () => {
      const credentials = {
        username: "testuser",
        password: "testpass123",
        apiKey: "sk-test-12345",
      };
      const plaintext = JSON.stringify(credentials);

      const encrypted = encryptCredentials(plaintext);
      const decrypted = decryptCredentials(encrypted);

      const parsed = JSON.parse(decrypted);
      expect(parsed).toEqual(credentials);
    });

    it("should produce different ciphertexts for the same plaintext (due to random IV)", () => {
      const plaintext = "same-plaintext-twice";

      const encrypted1 = encryptCredentials(plaintext);
      const encrypted2 = encryptCredentials(plaintext);

      // Due to random IV, ciphertexts should be different
      expect(encrypted1).not.toBe(encrypted2);

      // But both should decrypt to the same plaintext
      expect(decryptCredentials(encrypted1)).toBe(plaintext);
      expect(decryptCredentials(encrypted2)).toBe(plaintext);
    });

    it("should throw error when decrypting with invalid data", () => {
      const invalidData = "invalid:encrypted:data";

      expect(() => {
        decryptCredentials(invalidData);
      }).toThrow();
    });

    it("should throw error when decrypting with corrupted format", () => {
      const corruptedData = "not-three-parts";

      expect(() => {
        decryptCredentials(corruptedData);
      }).toThrow();
    });

    it("should throw error when decrypting with wrong auth tag", () => {
      const plaintext = "test-data";
      const encrypted = encryptCredentials(plaintext);
      const parts = encrypted.split(":");

      // Corrupt the auth tag
      const corrupted = `${parts[0]}:aabbccdd${parts[1].slice(8)}:${parts[2]}`;

      expect(() => {
        decryptCredentials(corrupted);
      }).toThrow();
    });

    it("should encrypt empty string", () => {
      const plaintext = "";

      const encrypted = encryptCredentials(plaintext);
      const decrypted = decryptCredentials(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it("should encrypt long plaintext", () => {
      const plaintext = "a".repeat(10000);

      const encrypted = encryptCredentials(plaintext);
      const decrypted = decryptCredentials(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it("should accept custom encryption key", () => {
      const plaintext = "test-data";
      const customKey = "custom-encryption-key-12345678";

      const encrypted = encryptCredentials(plaintext, customKey);
      const decrypted = decryptCredentials(encrypted, customKey);

      expect(decrypted).toBe(plaintext);
    });

    it("should fail when decrypting with different key", () => {
      const plaintext = "test-data";
      const key1 = "encryption-key-1-12345678901234";
      const key2 = "encryption-key-2-12345678901234";

      const encrypted = encryptCredentials(plaintext, key1);

      expect(() => {
        decryptCredentials(encrypted, key2);
      }).toThrow();
    });
  });
});
