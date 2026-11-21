FROM eclipse-mosquitto:2.0.23
USER root
RUN apk add --no-cache nodejs openssl
WORKDIR /opt/fcplcn
COPY setup.mjs ./setup.mjs
ENTRYPOINT ["node", "/opt/fcplcn/setup.mjs"]
