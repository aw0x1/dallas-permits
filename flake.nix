{
  description = "Dallas permits scraper — Playwright + SurrealDB";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }: let
    system = "x86_64-linux";
    pkgs = import nixpkgs { inherit system; };
  in {
    devShells.${system}.default = pkgs.mkShell {
      packages = with pkgs; [
        nodejs_22
        chromium
        surrealdb
      ];
      shellHook = ''
        export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$(which chromium)
        echo "chromium: $(chromium --version)"
        echo "node:     $(node --version)"
        echo "surreal:  $(surreal version 2>/dev/null || echo 'not running')"
        echo ""
        echo "Run 'surreal start --log debug --user root --pass root file:./data.db' to start SurrealDB"
      '';
    };
  };
}
