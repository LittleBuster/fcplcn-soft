# Build the browser assets on the builder's native CPU. The resulting server and
# production dependencies are JavaScript, so they also run on the target CPU.
ARG FCPLCN_NODE_RUNTIME_IMAGE=node:24.22.3-bookworm-slim
FROM --platform=$BUILDPLATFORM node:24.22.3-bookworm-slim AS build
WORKDIR /app/hub
COPY hub/package.json hub/package-lock.json ./
RUN npm ci
COPY config/product.json /app/config/product.json
COPY firmware/base/web /app/firmware/base/web
COPY firmware/base/tests/browser/*.cjs /app/firmware/base/tests/browser/
COPY firmware/base/tests/browser/simulator-inputs.js /app/firmware/base/tests/browser/
COPY hub/tsconfig*.json hub/vite.config.ts ./
COPY hub/server ./server
COPY hub/src ./src
COPY hub/shared ./shared
COPY hub/web ./web
COPY hub/scripts ./scripts
COPY hub/tests ./tests
RUN npm run build && npm prune --omit=dev

# Run the production assets on the selected target CPU with Node.js 24.
FROM ${FCPLCN_NODE_RUNTIME_IMAGE} AS runtime
ENV NODE_ENV=production \
    FCPLCN_HUB_HOST=0.0.0.0 \
    FCPLCN_HUB_PORT=3000 \
    FCPLCN_HUB_DATA_DIR=/var/lib/fcplcn
WORKDIR /app/hub
COPY --from=build --chown=node:node /app/hub/package.json ./
COPY --from=build --chown=node:node /app/hub/node_modules ./node_modules
COPY --from=build --chown=node:node /app/hub/dist ./dist
RUN mkdir -p /var/lib/fcplcn && chown node:node /var/lib/fcplcn
USER node
EXPOSE 3000
CMD ["node", "dist/server/main.js"]
