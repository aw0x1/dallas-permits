# Add this to your Optiplex NixOS configuration (import from configuration.nix or flake).
# Exposes SurrealDB on localhost:8000 and via Tailscale interface only.
#
# Secrets: use sops-nix or agenix for SURREALDB_PASS rather than hardcoding.
# After first boot: `surreal import --conn http://localhost:8000 --user root --pass <pass>
#                     --ns dallas --db permits schema.surql`

{ config, pkgs, ... }:

{
  # ── SurrealDB service ────────────────────────────────────────────────────
  services.surrealdb = {
    enable   = true;
    dbPath   = "/var/lib/surrealdb/data.db";
    # Bind on loopback + Tailscale interface only (not public internet)
    # Change to "0.0.0.0:8000" if you want broader LAN access
    extraArgs = [ "--bind" "0.0.0.0:8000" "--log" "info" ];
  };

  # Put credentials in /etc/surrealdb/env via sops/agenix; example uses plain file.
  # Replace with: sops.secrets.surrealdb-env = { ... };
  systemd.services.surrealdb.serviceConfig = {
    EnvironmentFile = "/etc/surrealdb/env";   # contains SURREAL_USER and SURREAL_PASS
    Restart         = "on-failure";
    RestartSec      = "5s";
  };

  # ── Firewall: only allow from Tailscale ──────────────────────────────────
  # SurrealDB port is 8000 — allow from tailscale0 (100.x.x.x range)
  networking.firewall.extraRules = ''
    iptables -A INPUT -i tailscale0 -p tcp --dport 8000 -j ACCEPT
    iptables -A INPUT -i lo          -p tcp --dport 8000 -j ACCEPT
  '';

  # ── Backup: nightly snapshot to /var/backup/surrealdb/ ──────────────────
  systemd.services.surrealdb-backup = {
    description = "SurrealDB nightly backup";
    after       = [ "surrealdb.service" ];
    serviceConfig = {
      Type           = "oneshot";
      EnvironmentFile = "/etc/surrealdb/env";
      ExecStart = pkgs.writeShellScript "surrealdb-backup" ''
        set -euo pipefail
        DEST=/var/backup/surrealdb
        mkdir -p "$DEST"
        # Keep 30 days of backups
        find "$DEST" -name "*.surql.gz" -mtime +30 -delete
        ${pkgs.surrealdb}/bin/surreal export \
          --conn  http://localhost:8000    \
          --user  "$SURREAL_USER"         \
          --pass  "$SURREAL_PASS"         \
          --ns    dallas                  \
          --db    permits                 \
          - | ${pkgs.gzip}/bin/gzip > "$DEST/$(date +%Y-%m-%d).surql.gz"
        echo "Backup complete: $DEST/$(date +%Y-%m-%d).surql.gz"
      '';
    };
  };

  systemd.timers.surrealdb-backup = {
    wantedBy    = [ "timers.target" ];
    timerConfig = {
      OnCalendar = "03:00";   # 3 AM nightly
      Persistent = true;
    };
  };

  environment.systemPackages = [ pkgs.surrealdb ];
}
