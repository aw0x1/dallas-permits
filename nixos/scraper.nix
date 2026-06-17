# NixOS module for the Dallas permits scraper on Optiplex.
# Imports: add to your flake or configuration.nix alongside surrealdb.nix
#
#   imports = [
#     ./surrealdb.nix
#     ./scraper.nix
#   ];

{ config, pkgs, lib, ... }:

let
  # Pin to the same chromium as the dev environment
  chromium = pkgs.chromium;
  node     = pkgs.nodejs_22;

  scraperDir = "/opt/dallas-permits";

  scraperEnv = {
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "${chromium}/bin/chromium";
    # SurrealDB runs in k3s NodePort 30800 on the Optiplex
    SURREALDB_URL  = "http://localhost:30800";
    SURREALDB_NS   = "dallas";
    SURREALDB_DB   = "permits";
    # SURREALDB_USER / SURREALDB_PASS come from EnvironmentFile (see below)
    # CLOUD_URL / CLOUD_TOKEN come from EnvironmentFile for sync-cloud
    HOME = "/var/lib/dallas-permits";
  };

in {

  # ── Deploy scraper code ───────────────────────────────────────────────────
  # Option A (recommended): let systemd pull from git on each run.
  # Option B: manage via NixOS flake input (more complex, more reproducible).
  # This module uses Option A for simplicity.

  systemd.services.dallas-permits-update = {
    description = "Pull latest dallas-permits code from GitHub";
    serviceConfig = {
      Type            = "oneshot";
      User            = "dallas-permits";
      WorkingDirectory = scraperDir;
      ExecStart = pkgs.writeShellScript "update-scraper" ''
        set -euo pipefail
        if [ ! -d "${scraperDir}/.git" ]; then
          ${pkgs.git}/bin/git clone https://github.com/aw0x1/dallas-permits.git ${scraperDir}
        else
          ${pkgs.git}/bin/git -C ${scraperDir} pull --ff-only
        fi
        ${node}/bin/npm ci --prefix ${scraperDir}
      '';
    };
  };

  # ── Daily incremental scrape ──────────────────────────────────────────────
  systemd.services.dallas-permits-scrape = {
    description = "Dallas permits daily incremental scrape";
    after       = [ "k3s.service" "network-online.target" ];
    wants       = [ "k3s.service" ];
    serviceConfig = {
      Type             = "oneshot";
      User             = "dallas-permits";
      WorkingDirectory = scraperDir;
      EnvironmentFile  = "/etc/dallas-permits/env";   # SURREALDB_USER, SURREALDB_PASS
      Environment      = lib.mapAttrsToList (k: v: "${k}=${v}") scraperEnv;
      ExecStart        = "${node}/bin/node ${scraperDir}/scripts/incremental.js";
      # Give plenty of time — browser automation is slow
      TimeoutStartSec  = "3600";
    };
  };

  systemd.timers.dallas-permits-scrape = {
    wantedBy    = [ "timers.target" ];
    timerConfig = {
      OnCalendar  = "02:30";   # 02:30 local (low-traffic hours)
      Persistent  = true;       # run on boot if missed
      RandomizedDelaySec = "300";
    };
  };

  # ── 90-day cloud sync (after scrape) ─────────────────────────────────────
  systemd.services.dallas-permits-sync = {
    description = "Sync last 90 days of permits to Surreal Cloud";
    after       = [ "dallas-permits-scrape.service" ];
    serviceConfig = {
      Type             = "oneshot";
      User             = "dallas-permits";
      WorkingDirectory = scraperDir;
      EnvironmentFile  = "/etc/dallas-permits/env";
      Environment      = lib.mapAttrsToList (k: v: "${k}=${v}") scraperEnv;
      ExecStart        = "${node}/bin/node ${scraperDir}/scripts/sync-cloud.js";
      TimeoutStartSec  = "1800";
    };
  };

  systemd.timers.dallas-permits-sync = {
    wantedBy    = [ "timers.target" ];
    timerConfig = {
      OnCalendar  = "03:30";   # 1 hour after scrape
      Persistent  = true;
    };
  };

  # ── One-time initial index (run manually) ─────────────────────────────────
  # Run with: systemctl start dallas-permits-index
  systemd.services.dallas-permits-index = {
    description = "Dallas permits full historical index (one-time)";
    after       = [ "k3s.service" "network-online.target" ];
    wants       = [ "k3s.service" ];
    serviceConfig = {
      Type             = "oneshot";
      User             = "dallas-permits";
      WorkingDirectory = scraperDir;
      EnvironmentFile  = "/etc/dallas-permits/env";
      Environment      = lib.mapAttrsToList (k: v: "${k}=${v}") scraperEnv
        ++ [ "START_DATE=2010-01-01" ];
      ExecStart        = "${node}/bin/node ${scraperDir}/scripts/index.js";
      TimeoutStartSec  = "86400";  # 24h max for full historical index
    };
  };

  # ── System user ───────────────────────────────────────────────────────────
  users.users.dallas-permits = {
    isSystemUser = true;
    group        = "dallas-permits";
    home         = "/var/lib/dallas-permits";
    createHome   = true;
  };
  users.groups.dallas-permits = {};

  # ── Credentials file (create manually on Optiplex) ────────────────────────
  # sudo mkdir -p /etc/dallas-permits
  # sudo tee /etc/dallas-permits/env <<EOF
  # SURREALDB_USER=root
  # SURREALDB_PASS=your_surreal_password
  # CLOUD_URL=https://shiny-ember-06fd8ca7vdtclfer6i1sgkc1o0.aws-use2.surreal.cloud
  # CLOUD_TOKEN=eyJ...
  # EOF
  # sudo chmod 600 /etc/dallas-permits/env
  # sudo chown root:dallas-permits /etc/dallas-permits/env

  environment.systemPackages = [ pkgs.chromium node pkgs.git ];
}
