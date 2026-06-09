# Closed-loop agent, packaged for EigenCompute (Docker -> Intel TDX TEE).
# The deployed image's digest is recorded on-chain; the loop's verdicts are
# therefore attestable to the exact code that ran inside the enclave.
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY loop.ts server.ts tsconfig.json config.json stages.json ./

# The HTTP wrapper runs the loop on boot and serves the attestable result.
# It binds 0.0.0.0:8080 so EigenCompute can health-check and attest it.
EXPOSE 8080

# ANTHROPIC_API_KEY is injected as a sealed EigenCompute secret. At boot the
# TEE entrypoint decrypts it to /tmp/.env (via KMS attestation); the server
# loads that file. The key is never baked into the image.
ENV PORT=8080
CMD ["node", "--env-file-if-exists=/tmp/.env", "--env-file-if-exists=.env", "--import", "tsx", "server.ts"]
