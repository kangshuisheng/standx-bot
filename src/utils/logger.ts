import pino from "pino";

export class Logger {
    private logger;
    
    constructor() {
        this.logger = pino({
            level: process.env.LOG_LEVEL || "info",
            transport: {
                target: "pino-pretty",
                options: {
                    colorize: true,
                    translateTime: "SYS:standard",
                },
            },
        });
    }

    info(msg: string, ...args: any[]) {
        this.logger.info(msg, ...args);
    }
    
    warn(msg: string, ...args: any[]) {
        this.logger.warn(msg, ...args);
    }

    error(msg: string, ...args: any[]) {
        this.logger.error(msg, ...args);
    }
}

