{
  description = "PageThreads — MV3 browser extension with a Zulip backend (dev toolchain)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        # `nix develop` (or direnv via .envrc) drops you into a shell with the
        # pinned Node/npm toolchain used to build and test the extension.
        #
        # Out of scope by design: the Zulip dev backend (Docker) and Chrome for
        # Testing are heavyweight, macOS-external tools Nix does not provide here
        # — see dev/zulip/README.md and dev/run-chrome.sh.
        devShells.default = pkgs.mkShell {
          packages = [ pkgs.nodejs_22 ];

          shellHook = ''
            echo "PageThreads dev shell — node $(node --version), npm $(npm --version)"
            echo "  npm install && npm run build   # → dist/ (unpacked MV3 extension)"
            echo "  npm test                       # Vitest"
          '';
        };
      }
    );
}
