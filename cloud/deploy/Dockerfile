# The repository root is the build context; both panels use the canonical product identity.
FROM --platform=$BUILDPLATFORM node:24.22.3-bookworm-slim AS build
WORKDIR /app
COPY hub/package.json hub/package-lock.json ./hub/
COPY cloud/package.json cloud/package-lock.json ./cloud/
RUN npm --prefix hub ci && npm --prefix cloud ci
COPY config/product.json ./config/product.json
COPY firmware/base/web ./firmware/base/web
COPY firmware/base/tests/browser/*.cjs ./firmware/base/tests/browser/
COPY firmware/base/tests/browser/simulator-inputs.js ./firmware/base/tests/browser/
COPY hub/tsconfig*.json hub/vite.config.ts ./hub/
COPY hub/server ./hub/server
COPY hub/src ./hub/src
COPY hub/shared ./hub/shared
COPY hub/web ./hub/web
COPY hub/scripts ./hub/scripts
COPY hub/tests ./hub/tests
COPY cloud/tsconfig*.json cloud/vite.config.ts ./cloud/
COPY cloud/server ./cloud/server
COPY cloud/shared ./cloud/shared
COPY cloud/web ./cloud/web
COPY cloud/scripts ./cloud/scripts
COPY cloud/tests ./cloud/tests
RUN npm --prefix hub run build && npm --prefix cloud run build \
    && npm --prefix cloud prune --omit=dev

FROM node:24.22.3-bookworm-slim AS runtime
ENV NODE_ENV=production \
    FCPLCN_CLOUD_HOST=0.0.0.0 \
    FCPLCN_CLOUD_PORT=4100 \
    FCPLCN_CLOUD_DATA_DIR=/var/lib/fcplcn
WORKDIR /app/cloud
COPY --from=build --chown=1000:1000 /app/cloud/package.json ./
COPY --from=build --chown=1000:1000 /app/cloud/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /app/cloud/dist ./dist
RUN mkdir -p /var/lib/fcplcn && chown 1000:1000 /var/lib/fcplcn
USER 1000:1000
EXPOSE 4100
CMD ["node", "dist/cloud/server/main.js"]
