import pino from "pino";
import { env } from "./env.js";

export const logger = pino({
  level: env.LOG_LEVEL,
  serializers: {
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
    requestId: (value) => value,
  },
  transport:
    env.NODE_ENV === "development"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
            ignore: "pid,hostname",
          },
        }
      : undefined,
});
