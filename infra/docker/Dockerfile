FROM node:24.18.0-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY docs ./docs
RUN pnpm install --frozen-lockfile
RUN pnpm -r --if-present build

FROM node:24.18.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY --from=build /workspace/package.json /workspace/pnpm-lock.yaml /workspace/pnpm-workspace.yaml /workspace/.npmrc ./
COPY --from=build /workspace/apps ./apps
COPY --from=build /workspace/packages ./packages
RUN pnpm install --prod --frozen-lockfile
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
