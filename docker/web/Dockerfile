# syntax=docker/dockerfile:1
# The web client as static files behind Caddy. Nothing server-specific is built in: the container renders
# /config.js from TRESSO_API_URL when it serves it, so one image works for every Tresso server.
FROM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
COPY apps/mobile/package.json apps/mobile/
RUN npm ci --workspace @tresso/web --include-workspace-root --no-audit --no-fund
COPY packages/core/ packages/core/
COPY apps/web/ apps/web/
# The API address comes from /config.js at runtime; the OAuth client and redirect are the same for every server.
ENV VITE_API_URL="" \
    VITE_OAUTH_CLIENT_ID=web \
    VITE_DESKTOP_OAUTH_CLIENT_ID=desktop \
    VITE_NATIVE_REDIRECT_URI=tresso://auth/callback
RUN npm run build-only --workspace @tresso/web

FROM caddy:2.10-alpine AS prod
COPY docker/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/apps/web/dist /srv
COPY docker/web/config.js /srv/config.js
EXPOSE 80
