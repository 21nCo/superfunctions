# Keep browser and host Playwright versions aligned. Provision explicitly; runtime never pulls.
FROM mcr.microsoft.com/playwright:v1.57.0-noble@sha256:3bed4b1a12f2338642f3d8cba28e291deef3c66bd4a964bbeb3e57bbff511dbd
USER root
RUN mkdir -p /opt/browse-worker && npm install --prefix /opt/browse-worker --omit=dev --ignore-scripts --no-audit --no-fund playwright@1.57.0 puppeteer-core@24.33.0
USER pwuser
