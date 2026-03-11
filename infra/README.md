# Stratos Infrastructure (AWS CDK)

Deploys the Stratos API service and webapp on **ECS Fargate** with Application Load Balancers, ACM SSL certificates, and Route53 DNS records.

## Architecture

```
Route53 (*.example.com)
  ├── stratos.example.com → ALB → ECS Fargate (Stratos API, port 3100)
  │                                  ├── EFS volume (/app/data)
  │                                  └── RDS PostgreSQL
  └── app.example.com     → ALB → ECS Fargate (Webapp nginx, port 80)
```

**Stacks:**

| Stack                   | Resources                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `Stratos-Network-{env}` | VPC (2 AZ, NAT gateway), ECS cluster, Route53 zone lookup                                 |
| `Stratos-Service-{env}` | Fargate service, ALB, ACM certificate, EFS, RDS, Route53 A record                         |
| `Stratos-Webapp-{env}`  | Fargate service, ALB, ACM certificate, Route53 A record                                   |

## Prerequisites

- AWS CLI configured with appropriate credentials
- Node.js 20+
- pnpm
- Docker (for building container images)

## Setup

```bash
cd infra
pnpm install
```

## Configuration

All configuration is via environment variables:

### Required

| Variable                  | Description                                                         |
| ------------------------- | ------------------------------------------------------------------- |
| `CDK_DEFAULT_ACCOUNT`     | AWS account ID                                                      |
| `CDK_DEFAULT_REGION`      | AWS region                                                          |
| `STRATOS_DOMAIN_NAME`     | Route53 hosted zone domain (e.g. `example.com`)                     |
| `STRATOS_SERVICE_DID`     | Stratos service DID                                                 |
| `STRATOS_PUBLIC_URL`      | Public URL for the Stratos API (e.g. `https://stratos.example.com`) |
| `STRATOS_ALLOWED_DOMAINS` | Comma-separated allowed domains                                     |

### Optional

| Variable                 | Default      | Description                                       |
| ------------------------ | ------------ | ------------------------------------------------- |
| `STRATOS_HOSTED_ZONE_ID` | (looked up)  | Route53 hosted zone ID — skips lookup if provided |
| `STRATOS_ENVIRONMENT`    | `production` | Environment name (used in stack names)            |
| `STRATOS_SUBDOMAIN`      | `stratos`    | Subdomain for the API                             |
| `WEBAPP_SUBDOMAIN`       | `app`        | Subdomain for the webapp                          |
| `STRATOS_TASK_CPU`       | `512`        | Stratos task CPU (256, 512, 1024, 2048, 4096)     |
| `STRATOS_TASK_MEMORY`    | `1024`       | Stratos task memory in MiB                        |
| `WEBAPP_TASK_CPU`        | `256`        | Webapp task CPU                                   |
| `WEBAPP_TASK_MEMORY`     | `512`        | Webapp task memory in MiB                         |
| `STRATOS_DESIRED_COUNT`  | `1`          | Stratos task count                                |
| `WEBAPP_DESIRED_COUNT`   | `1`          | Webapp task count                                 |

### Storage Backend

| Variable                 | Default    | Description                                        |
| ------------------------ | ---------- | -------------------------------------------------- |
| `STORAGE_BACKEND`        | `postgres` | `sqlite` mounts EFS into ECS; `postgres` injects RDS credentials into ECS |
| `STRATOS_PG_DB_NAME`     | `stratos`  | PostgreSQL database name                           |
| `STRATOS_PG_STORAGE_GIB` | `20`       | Allocated RDS storage in GiB                       |

The service stack always creates:

- **EFS** file system and access point for `/app/data`
- **RDS PostgreSQL 16** instance (`db.t4g.micro`) in private subnets
- **Secrets Manager** secret with auto-generated credentials
- Security group allowing port 5432 only from the Fargate service

When `STORAGE_BACKEND=postgres`, the ECS task is wired to use RDS by injecting these secret fields into the container:

- Individual secret fields (`STRATOS_PG_HOST`, `STRATOS_PG_PORT`, `STRATOS_PG_USERNAME`, `STRATOS_PG_PASSWORD`, `STRATOS_PG_DBNAME`) injected into the container via ECS secrets

When `STORAGE_BACKEND=sqlite`, the ECS task mounts the EFS file system at `/app/data`.
All `STRATOS_*` environment variables from the Stratos service are also supported (see `docker-compose.yml` for the full list).

## Deploy

```bash
# Preview changes
npx cdk diff

# Deploy all stacks
npx cdk deploy --all

# Deploy a specific stack
npx cdk deploy Stratos-Service-production
```

## Destroy

```bash
npx cdk destroy --all
```

> **Note:** The EFS file system and RDS instance have `RETAIN` removal policy and will not be deleted automatically. The RDS instance also has deletion protection enabled.
