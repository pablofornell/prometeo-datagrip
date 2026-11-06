# Prometeo DataGrip: developer commands.
# Run `make` or `make help` to see the targets.

SHELL := /bin/bash
.DEFAULT_GOAL := help

CARGO ?= cargo
NPM   ?= npm
NPX   ?= npx

# Test databases (Docker). The integration tests load their own seed data
# (crates/dbcore/tests/fixtures), so the containers only need to run.
PG_CONTAINER    ?= prometeo-pg
PG_IMAGE        ?= postgres:16
PG_PORT         ?= 54329
PG_PASSWORD     ?= prometeo
MYSQL_CONTAINER ?= prometeo-mysql
MYSQL_IMAGE     ?= mysql:8
MYSQL_PORT      ?= 33069
MYSQL_PASSWORD  ?= prometeo

DB_ENV := PROMETEO_PG_URL=postgres://postgres:$(PG_PASSWORD)@127.0.0.1:$(PG_PORT)/postgres \
          PROMETEO_MYSQL_URL=mysql://root:$(MYSQL_PASSWORD)@127.0.0.1:$(MYSQL_PORT)/demo \
          PROMETEO_NO_KEYRING=1

.PHONY: help install dev build bundle \
        test test-ui test-rust test-rust-db test-all \
        lint typecheck clippy fmt fmt-check check ci \
        db-up db-down db-reset db-status clean

help: ## Show this help
	@awk 'BEGIN {FS = ":.*## "; printf "Targets:\n"} /^[a-zA-Z_-]+:.*## / {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

## ---- Setup and run ----

install: ## Install the frontend dependencies
	$(NPM) install

dev: ## Run the app in development mode (Vite + Tauri)
	$(NPM) run tauri dev

build: ## Build the optimized release binary (no installer bundles)
	$(NPX) tauri build --no-bundle
	@echo "Binary: target/release/prometeo-datagrip"

bundle: ## Build the release binary and the installer bundles (deb, AppImage, ...)
	$(NPX) tauri build

## ---- Tests ----

test: test-ui test-rust ## Run the unit tests (frontend + Rust, no databases needed)

test-ui: ## Run the frontend tests (vitest)
	$(NPM) test

test-rust: ## Run the Rust tests; database tests skip without the DB env
	PROMETEO_NO_KEYRING=1 $(CARGO) test --workspace

test-rust-db: db-up ## Run the Rust tests against the PostgreSQL and MySQL containers
	$(DB_ENV) $(CARGO) test --workspace --no-fail-fast

test-all: test-ui test-rust-db ## Run every test, including the database integration tests

## ---- Quality ----

typecheck: ## Type-check the frontend (strict TypeScript)
	$(NPX) tsc --noEmit

clippy: ## Lint the Rust code (warnings are errors)
	$(CARGO) clippy --workspace --all-targets -- -D warnings

lint: typecheck clippy ## Type-check and lint everything

fmt: ## Format the Rust code
	$(CARGO) fmt --all

fmt-check: ## Check the Rust formatting
	$(CARGO) fmt --all -- --check

check: lint test ## Lint plus unit tests (quick check before a commit)

ci: lint test-all ## Everything a CI run does: lint, all tests with databases, frontend build
	$(NPM) run build

## ---- Test databases (Docker) ----

db-up: ## Start the PostgreSQL and MySQL test containers (and wait until ready)
	@set -euo pipefail; \
	start() { \
	  name=$$1; shift; \
	  if docker ps --format '{{.Names}}' | grep -qx "$$name"; then echo "[db] $$name is running"; \
	  elif docker ps -a --format '{{.Names}}' | grep -qx "$$name"; then echo "[db] starting $$name"; docker start "$$name" >/dev/null; \
	  else echo "[db] creating $$name"; docker run -d --name "$$name" "$$@" >/dev/null; fi; \
	}; \
	start $(PG_CONTAINER) -e POSTGRES_PASSWORD=$(PG_PASSWORD) -p $(PG_PORT):5432 $(PG_IMAGE); \
	start $(MYSQL_CONTAINER) -e MYSQL_ROOT_PASSWORD=$(MYSQL_PASSWORD) -e MYSQL_DATABASE=demo -p $(MYSQL_PORT):3306 $(MYSQL_IMAGE); \
	echo "[db] waiting for PostgreSQL"; \
	for i in $$(seq 1 60); do docker exec $(PG_CONTAINER) pg_isready -U postgres -q && break; sleep 1; done; \
	docker exec $(PG_CONTAINER) pg_isready -U postgres -q || { echo "[db] PostgreSQL is not ready"; exit 1; }; \
	echo "[db] waiting for MySQL"; \
	for i in $$(seq 1 90); do docker exec $(MYSQL_CONTAINER) mysqladmin ping -uroot -p$(MYSQL_PASSWORD) --silent >/dev/null 2>&1 && break; sleep 1; done; \
	docker exec $(MYSQL_CONTAINER) mysqladmin ping -uroot -p$(MYSQL_PASSWORD) --silent >/dev/null 2>&1 || { echo "[db] MySQL is not ready"; exit 1; }; \
	echo "[db] ready: PostgreSQL 127.0.0.1:$(PG_PORT), MySQL 127.0.0.1:$(MYSQL_PORT)"

db-down: ## Stop the test containers (data is kept)
	-docker stop $(PG_CONTAINER) $(MYSQL_CONTAINER)

db-reset: ## Remove the test containers and their data, then start new ones
	-docker rm -f $(PG_CONTAINER) $(MYSQL_CONTAINER)
	$(MAKE) db-up

db-status: ## Show the state of the test containers
	@docker ps -a --filter name=$(PG_CONTAINER) --filter name=$(MYSQL_CONTAINER) --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

## ---- Cleanup ----

clean: ## Remove build output (target/ and dist/); keeps node_modules
	$(CARGO) clean
	rm -rf -- dist
