# FileFn processing container (Cloudflare Containers image).
# Build from the repository root:
#   docker build --platform linux/amd64 -f filefn/processing/container/Dockerfile -t filefn-processing .
# The `build` stage also runs the container's test suite in CI.

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
# ffmpeg and tesseract (with English language data) are native tools the processors
# call; sharp brings its own libvips through its prebuilt npm package.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg tesseract-ocr tesseract-ocr-eng \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
  NPM_CONFIG_FUND=false \
  NPM_CONFIG_AUDIT=false

# The container's workspace and the workspaces it builds from source, in build order.
ENV FILEFN_CONTAINER_WORKSPACES="@superfunctions/observability @superfunctions/files @superfunctions/storage @superfunctions/storage-r2 @filefn/server @filefn/processing @filefn/processing-container"

FROM base AS build
COPY . .
RUN npm ci --ignore-scripts --include-workspace-root=false \
    $(for name in $FILEFN_CONTAINER_WORKSPACES; do printf -- '--workspace %s ' "$name"; done) \
  && node scripts/ci-install-rollup-native.mjs \
  && for name in $FILEFN_CONTAINER_WORKSPACES; do npm run build --workspace "$name" || exit 1; done

FROM base AS deps
COPY . .
RUN npm ci --omit=dev --ignore-scripts --include-workspace-root=false \
    $(for name in $FILEFN_CONTAINER_WORKSPACES; do printf -- '--workspace %s ' "$name"; done) \
  && rm -rf scripts

FROM base AS runtime
ENV NODE_ENV=production \
  PORT=8080
COPY --from=deps /app /app
COPY --from=build /app/packages/observability/dist /app/packages/observability/dist
COPY --from=build /app/packages/files/dist /app/packages/files/dist
COPY --from=build /app/packages/storage/dist /app/packages/storage/dist
COPY --from=build /app/packages/storage-r2/dist /app/packages/storage-r2/dist
COPY --from=build /app/filefn/server/dist /app/filefn/server/dist
COPY --from=build /app/filefn/processing/dist /app/filefn/processing/dist
COPY --from=build /app/filefn/processing/container/dist /app/filefn/processing/container/dist
WORKDIR /app/filefn/processing/container
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
