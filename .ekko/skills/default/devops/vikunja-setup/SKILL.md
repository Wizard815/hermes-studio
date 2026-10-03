---
name: vikunja-setup
description: Deploy and configure Vikunja task manager with CalDAV support in Docker Compose, including config, user creation, and API verification.
keywords:
  - vikunja deployment
  - caldav server setup
  - docker compose task manager
  - vikunja config file
  - user creation cli
---

# Vikunja Setup

Deploy Vikunja (v2.x) as a Docker container with CalDAV and task management, integrated into a Docker Compose stack.

## Docker Compose Configuration

```yaml
vikunja:
  image: ghcr.io/go-vikunja/vikunja:latest
  container_name: vikunja
  restart: unless-stopped
  networks:
    - ai_net
    - proxynat
  ports:
    - "3457:3456"
  volumes:
    - ./vikunja/config/config.yml:/app/vikunja/config.yml
    - ./vikunja/db:/db
    - ./vikunja/files:/app/vikunja/files
```

## Config File (`config.yml`)

Required path: `/app/vikunja/config.yml` inside the container.

```yaml
service:
  secret: changeme-change-this-in-production
  interface: :3456
  publicurl: http://localhost:3457
  enablecaldav: true
  enablelinksharing: true
  enableregistration: false
  enabletaskattachments: true
  enabletaskcomments: true
  enabletotp: true
  timezone: GMT

database:
  type: sqlite
  path: /db/vikunja.db

files:
  type: local
  basepath: /app/vikunja/files

cors:
  enable: true
  origins:
    - http://localhost:3000
    - http://localhost:6767
    - http://localhost:6868
```

**Critical**: `service.publicurl` is required when `cors.enable: true`. Without it, Vikunja will fail to start.

## User Creation

Use the container CLI (no `--admin` flag exists):

```bash
docker exec vikunja vikunja user create -u admin -e admin@example.com -p password
```

Verify with API (note: key is `userName` camelCase, NOT `user_name`):
```bash
curl -X POST http://localhost:3457/api/v1/login -H "Content-Type: application/json" -d '{"userName":"admin","password":"password"}'
```

## CalDAV Access

- Web UI: `http://localhost:3457`
- CalDAV endpoint: `http://localhost:3457/dav/calendars/`
- Calendar path: `/dav/calendars/{username}/`

## Troubleshooting

- "No config file found" → Verify volume mount path is `/app/vikunja/config.yml`
- "service.publicurl is required when cors.enable is true" → Set `service.publicurl` in config
- "unknown flag: --admin" → Use `vikunja user create` without admin flag; admin status is assigned via API or registration settings