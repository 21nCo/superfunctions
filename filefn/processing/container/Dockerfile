# FileFn processing container (Cloudflare Containers image).
# Build from the repository root:
#   docker build --platform linux/amd64 -f filefn/processing/container/Dockerfile -t filefn-processing .
# The `build` stage also runs the container's test suite in CI.

ARG NODE_IMAGE=node:22-trixie-slim

FROM ${NODE_IMAGE} AS base
# ffmpeg and tesseract (with English language data) are native tools the processors
# call. libvips is Debian's build, which reads PDFs through poppler; sharp is
# compiled against it below because sharp's prebuilt libvips has no PDF loader.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg libvips42t64 tesseract-ocr tesseract-ocr-eng \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
  NPM_CONFIG_FUND=false \
  NPM_CONFIG_AUDIT=false

# The container's workspace and the workspaces it builds from source, in build order.
ENV FILEFN_CONTAINER_WORKSPACES="@superfunctions/observability @superfunctions/db @superfunctions/middleware @superfunctions/files @superfunctions/storage @superfunctions/storage-r2 @filefn/server @filefn/processing @filefn/processing-container"

# Production dependencies. The prebuilt sharp binaries are removed so only the
# binding compiled against the system libvips can load.
FROM base AS deps
COPY . .
RUN npm ci --omit=dev --ignore-scripts --include-workspace-root=false \
    $(for name in $FILEFN_CONTAINER_WORKSPACES; do printf -- '--workspace %s ' "$name"; done) \
  && rm -rf scripts node_modules/@img/sharp-*

# Compiles sharp's binding against the system libvips (node-gyp ships with npm;
# the headers come from the Node image, so the build needs no network).
FROM deps AS sharp-native
ARG NODE_ADDON_API_VERSION=8.1.0
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential libvips-dev pkg-config python3 \
  && rm -rf /var/lib/apt/lists/*
RUN npm install --prefix /opt/sharp-build --ignore-scripts --no-save --no-package-lock "node-addon-api@${NODE_ADDON_API_VERSION}" \
  && cd node_modules/sharp/src \
  && NODE_PATH=/opt/sharp-build/node_modules \
    node /usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild --nodedir=/usr/local \
  && rm -rf build/Release/obj.target build/Release/.deps \
  && cd /app \
  && node -e "const s=require('sharp'); \
      if (!s.format.pdf.input.buffer) { console.error('sharp has no PDF loader'); process.exit(1); } \
      console.log('sharp', s.versions.sharp, 'libvips', s.versions.vips, 'pdf input');"

FROM base AS build
COPY . .
RUN npm ci --ignore-scripts --include-workspace-root=false \
    $(for name in $FILEFN_CONTAINER_WORKSPACES; do printf -- '--workspace %s ' "$name"; done) \
  && rm -rf node_modules/@img/sharp-* \
  && node scripts/ci-install-rollup-native.mjs \
  && for name in $FILEFN_CONTAINER_WORKSPACES; do npm run build --workspace "$name" || exit 1; done
COPY --from=sharp-native /app/node_modules/sharp/src/build /app/node_modules/sharp/src/build

FROM base AS runtime
ENV NODE_ENV=production \
  PORT=8080
COPY --from=deps /app /app
COPY --from=sharp-native /app/node_modules/sharp/src/build /app/node_modules/sharp/src/build
COPY --from=build /app/packages/observability/dist /app/packages/observability/dist
COPY --from=build /app/packages/db/dist /app/packages/db/dist
COPY --from=build /app/packages/middleware/dist /app/packages/middleware/dist
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
