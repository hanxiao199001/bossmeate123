import { describe, it, expect, vi } from "vitest";
import { computeTrendLabel, type TrendLabel } from "../services/agents/keyword-trend.js";

// Mock the database and logger
vi.mock("../../models/db.js", () => ({
  db: {},
}));

vi.mock("../../config/logger.js", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../../config/env.js", () => ({
  env: {
    LOG_LEVEL: "error",
    NODE_ENV: "test",
  },
}));

describe("Keyword Trend Analysis", () => {
  describe("computeTrendLabel", () => {
    it("should classify keyword as stable when no history", () => {
      const keyword = "test-keyword";
      const history: any[] = [];

      const trend = computeTrendLabel(keyword, history);

      expect(trend.keyword).toBe(keyword);
      expect(trend.trend).toBe("stable");
      expect(trend.score7d).toBe(0);
      expect(trend.avgScore7d).toBe(0);
    });

    it("should classify keyword as exploding with >200% change in 7 days", () => {
      const keyword = "rocket-trending";

      // Simulate old data (7+ days ago)
      const oldHistory = Array.from({ length: 5 }, (_, i) => ({
        date: `2024-03-0${i + 1}`,
        heatScore: 100,
        compositeScore: 100,
        platforms: ["twitter"],
      }));

      // Simulate recent data (last 7 days) with huge jump
      const recentHistory = Array.from({ length: 3 }, (_, i) => ({
        date: `2024-03-${10 + i}`,
        heatScore: 500,
        compositeScore: 500,
        platforms: ["twitter", "weibo"],
      }));

      const history = [...oldHistory, ...recentHistory];
      const trend = computeTrendLabel(keyword, history);

      expect(trend.trend).toBe("exploding");
      expect(trend.score7d).toBeGreaterThan(200);
    });

    it("should classify keyword as rising with >50% change in 7 days", () => {
      const keyword = "rising-trend";

      const oldHistory = Array.from({ length: 5 }, (_, i) => ({
        date: `2024-03-0${i + 1}`,
        heatScore: 100,
        compositeScore: 100,
        platforms: ["twitter"],
      }));

      const recentHistory = Array.from({ length: 3 }, (_, i) => ({
        date: `2024-03-${10 + i}`,
        heatScore: 180,
        compositeScore: 180,
        platforms: ["twitter"],
      }));

      const history = [...oldHistory, ...recentHistory];
      const trend = computeTrendLabel(keyword, history);

      expect(trend.trend).toBe("rising");
      expect(trend.score7d).toBeGreaterThan(50);
      expect(trend.score7d).toBeLessThan(200);
    });

    it("should classify keyword as stable when change is within 50% and -30%", () => {
      const keyword = "stable-keyword";

      const history = Array.from({ length: 10 }, (_, i) => ({
        date: `2024-03-${i + 1}`,
        heatScore: 100 + Math.random() * 20,
        compositeScore: 100 + Math.random() * 20,
        platforms: ["twitter"],
      }));

      const trend = computeTrendLabel(keyword, history);

      expect(trend.trend).toBe("stable");
      expect(trend.score7d).toBeGreaterThanOrEqual(-30);
      expect(trend.score7d).toBeLessThan(50);
    });

    it("should classify keyword as cooling with <-30% change in 7 days", () => {
      const keyword = "cooling-keyword";

      const oldHistory = Array.from({ length: 5 }, (_, i) => ({
        date: `2024-03-0${i + 1}`,
        heatScore: 300,
        compositeScore: 300,
        platforms: ["twitter"],
      }));

      const recentHistory = Array.from({ length: 3 }, (_, i) => ({
        date: `2024-03-${10 + i}`,
        heatScore: 180,
        compositeScore: 180,
        platforms: ["twitter"],
      }));

      const history = [...oldHistory, ...recentHistory];
      const trend = computeTrendLabel(keyword, history);

      expect(trend.trend).toBe("cooling");
      expect(trend.score7d).toBeLessThan(-30);
    });

    it("should classify keyword as new if seen <3 days ago", () => {
      const keyword = "brand-new-trend";
      const now = new Date();

      // Only 2 days of history
      const recentHistory = Array.from({ length: 2 }, (_, i) => {
        const d = new Date();
        d.setDate(d.getDate() - (1 - i));
        return {
          date: d.toISOString().split("T")[0],
          heatScore: 100,
          compositeScore: 100,
          platforms: ["twitter"],
        };
      });

      const trend = computeTrendLabel(keyword, recentHistory);

      expect(trend.trend).toBe("new");
      expect(trend.firstSeenDaysAgo).toBeLessThanOrEqual(3);
    });

    it("should calculate correct average scores for 7 days", () => {
      const keyword = "test-keyword";
      const scores = [100, 110, 120, 130, 140, 150, 160];

      const history = Array.from({ length: 7 }, (_, i) => {
        const d = new Date();
        d.setDate(d.getDate() - (6 - i));
        return {
          date: d.toISOString().split("T")[0],
          heatScore: scores[i],
          compositeScore: scores[i],
          platforms: ["twitter"],
        };
      });

      const trend = computeTrendLabel(keyword, history);

      const expectedAvg = scores.reduce((a, b) => a + b, 0) / scores.length;
      expect(Math.abs(trend.avgScore7d - expectedAvg)).toBeLessThan(1);
    });

    it("should calculate correct sparkline for 7 days", () => {
      const keyword = "test-keyword";
      const scores = [100, 110, 120, 130, 140, 150, 160];

      const history = Array.from({ length: 7 }, (_, i) => {
        const d = new Date();
        d.setDate(d.getDate() - (6 - i));
        return {
          date: d.toISOString().split("T")[0],
          heatScore: scores[i],
          compositeScore: scores[i],
          platforms: ["twitter"],
        };
      });

      const trend = computeTrendLabel(keyword, history);

      expect(trend.sparkline).toHaveLength(7);
      expect(trend.sparkline).toEqual(scores);
    });

    it("should handle missing days in sparkline with zeros", () => {
      const keyword = "test-keyword";

      // Only have data for 3 of the last 7 days
      const history = [
        {
          date: new Date().toISOString().split("T")[0],
          heatScore: 150,
          compositeScore: 150,
          platforms: ["twitter"],
        },
        {
          date: new Date(Date.now() - 2 * 86400000).toISOString().split("T")[0],
          heatScore: 100,
          compositeScore: 100,
          platforms: ["twitter"],
        },
      ];

      const trend = computeTrendLabel(keyword, history);

      expect(trend.sparkline).toHaveLength(7);
      expect(trend.sparkline[trend.sparkline.length - 1]).toBe(150); // Today
      expect(trend.sparkline[trend.sparkline.length - 3]).toBe(100); // 2 days ago
    });

    it("should collect current platforms from latest data", () => {
      const keyword = "multi-platform-keyword";
      const platforms = ["twitter", "weibo", "tiktok"];

      const history = [
        {
          date: "2024-03-01",
          heatScore: 100,
          compositeScore: 100,
          platforms: ["twitter"],
        },
        {
          date: "2024-03-10",
          heatScore: 150,
          compositeScore: 150,
          platforms,
        },
      ];

      const trend = computeTrendLabel(keyword, history);

      expect(trend.platforms).toEqual(platforms);
    });

    it("should handle keyword with category information", () => {
      const keyword = "test-keyword";
      const category = "technology";
      const kwRecord = {
        category,
        firstSeenAt: new Date(Date.now() - 5 * 86400000), // 5 days ago
      };

      const history = Array.from({ length: 5 }, (_, i) => ({
        date: `2024-03-${i + 1}`,
        heatScore: 100,
        compositeScore: 100,
        platforms: ["twitter"],
      }));

      const trend = computeTrendLabel(keyword, history, kwRecord);

      expect(trend.category).toBe(category);
      expect(trend.firstSeenDaysAgo).toBeLessThanOrEqual(6);
    });

    it("should return complete TrendLabel object with all required fields", () => {
      const keyword = "complete-trend";
      const history = [
        {
          date: "2024-03-01",
          heatScore: 100,
          compositeScore: 100,
          platforms: ["twitter"],
        },
        {
          date: "2024-03-02",
          heatScore: 120,
          compositeScore: 120,
          platforms: ["twitter"],
        },
      ];

      const trend = computeTrendLabel(keyword, history);

      expect(trend).toHaveProperty("keyword");
      expect(trend).toHaveProperty("trend");
      expect(trend).toHaveProperty("score7d");
      expect(trend).toHaveProperty("score30d");
      expect(trend).toHaveProperty("currentScore");
      expect(trend).toHaveProperty("avgScore7d");
      expect(trend).toHaveProperty("avgScore30d");
      expect(trend).toHaveProperty("sparkline");
      expect(trend).toHaveProperty("platforms");
      expect(trend).toHaveProperty("category");
      expect(trend).toHaveProperty("firstSeenDaysAgo");

      expect(typeof trend.keyword).toBe("string");
      expect(["exploding", "rising", "stable", "cooling", "new"]).toContain(trend.trend);
      expect(Array.isArray(trend.sparkline)).toBe(true);
      expect(Array.isArray(trend.platforms)).toBe(true);
    });

    it("should handle very old data correctly", () => {
      const keyword = "old-trend";
      const oldHistory = Array.from({ length: 20 }, (_, i) => ({
        date: `2024-01-${i + 1}`,
        heatScore: 100,
        compositeScore: 100,
        platforms: ["twitter"],
      }));

      const trend = computeTrendLabel(keyword, oldHistory);

      expect(trend).toBeDefined();
      expect(typeof trend.score30d).toBe("number");
      expect(typeof trend.avgScore30d).toBe("number");
    });

    it("should calculate positive score change correctly", () => {
      const keyword = "growth-keyword";
      const history = Array.from({ length: 10 }, (_, i) => {
        // Simulate gradual growth
        const score = 100 + i * 20;
        const d = new Date();
        d.setDate(d.getDate() - (9 - i));
        return {
          date: d.toISOString().split("T")[0],
          heatScore: score,
          compositeScore: score,
          platforms: ["twitter"],
        };
      });

      const trend = computeTrendLabel(keyword, history);

      expect(trend.score7d).toBeGreaterThan(0);
      expect(trend.score30d).toBeGreaterThan(0);
    });

    it("should calculate negative score change correctly", () => {
      const keyword = "declining-keyword";
      const history = Array.from({ length: 10 }, (_, i) => {
        // Simulate gradual decline
        const score = 300 - i * 20;
        const d = new Date();
        d.setDate(d.getDate() - (9 - i));
        return {
          date: d.toISOString().split("T")[0],
          heatScore: score,
          compositeScore: score,
          platforms: ["twitter"],
        };
      });

      const trend = computeTrendLabel(keyword, history);

      expect(trend.score7d).toBeLessThan(0);
    });
  });
});
