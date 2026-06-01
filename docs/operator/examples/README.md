# Stratos Deployment Examples

This directory contains sample configurations for common Stratos deployment scenarios.

## Example 1: SQLite (Recommended for Small/Medium Instances)

A lightweight deployment using local SQLite databases for actor storage.

- [docker-compose.sqlite.yml](./docker-compose.sqlite.yml)
- [.env.sqlite.example](./.env.sqlite.example)

## Example 2: PostgreSQL (Recommended for High Traffic/Scale)

A robust deployment using a central PostgreSQL database for all actor storage.

- [docker-compose.postgres.yml](./docker-compose.postgres.yml)
- [.env.postgres.example](./.env.postgres.example)

## Example 3: Full Stack (Service + Indexer + Postgres)

A complete environment including the Stratos Service, the standalone Indexer, and a PostgreSQL database for AppView-ready storage.

- [docker-compose.full.yml](./docker-compose.full.yml)
- [.env.full.example](./.env.full.example)
