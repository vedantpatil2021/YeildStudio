# syntax=docker/dockerfile:1
# Yield Studio website. Two stages: Node builds the static site; the runtime image is unprivileged nginx serving
# only the built files (no Node, no node_modules, no sources).
#
# Vite bakes VITE_* settings into the bundle at build time. They are read from frontend/.env.local, passed in as a
# build secret (see docker-compose.yml), so the file never lands in an image layer. These values are public by
# design (the browser sees them): the Supabase URL, the anon/publishable key, the OTP length and the API URL.

# ---- build ---------------------------------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY . .
ARG BASE_PATH=/
ENV BASE_PATH=$BASE_PATH
RUN --mount=type=secret,id=frontend_env,target=/app/.env.local,required=false \
    npm run build && rm -rf dist/cog

# ---- runtime -------------------------------------------------------------------------------------------------
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
