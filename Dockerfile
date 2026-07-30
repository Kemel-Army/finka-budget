# Статический сайт (HTML/CSS/JS без сборки) на nginx
FROM nginx:1.27-alpine

WORKDIR /usr/share/nginx/html
RUN rm -rf ./*

# Файлы сайта (лишнее отсекается через .dockerignore)
COPY . .

# Конфигурация сервера выносится из корня сайта
RUN mv docker/nginx.conf /etc/nginx/conf.d/default.conf && rm -rf docker

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
