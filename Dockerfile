# 使用官方 Bun 镜像
FROM oven/bun:1.2-alpine

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 lockfile
COPY package.json bun.lockb ./

# 安装依赖
RUN bun install --frozen-lockfile --production

# 复制源代码
COPY src ./src
COPY scripts ./scripts
COPY tsconfig.json ./

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD bun --version || exit 1

# 启动命令
CMD ["bun", "run", "src/index.ts"]
