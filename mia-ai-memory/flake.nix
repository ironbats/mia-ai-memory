# Nix flake for ai-memory.
#
# Provides:
#   nix build              # → result/bin/ai-memory  (native release binary)
#   nix run . -- --version # smoke-test without installing
#   nix develop            # dev shell with Rust 1.95 (pinned)
#
# The build is self-contained: SQLite is bundled via rusqlite's `bundled`
# feature, libgit2 is vendored via git2's `vendored-libgit2` feature, and
# TLS uses rustls (webpki-roots) — no OpenSSL, no system-library hunting.
# The only extra step is TAILWIND_SKIP=1 so the web crate's build script
# uses the vendored static/tailwind.css instead of downloading the
# Tailwind CLI (which a sandboxed Nix build cannot do).
#
# `doCheck = false` skips the packaging test suite. Those tests exercise
# `bin/ai-memory`, a Docker-wrapper shell script that needs `docker` or
# `podman` on PATH — they are host-environment tests, not build tests,
# and are not Nix's responsibility. Run them manually with
# `nix develop -c cargo test -p ai-memory-cli --test packaging` if your
# machine has Docker.

{
  description = "Long-term memory for AI coding agents";

  # Inputs are pinned to explicit revisions rather than floating branches.
  #
  # A flake's value is reproducibility, and `github:NixOS/nixpkgs/nixos-unstable`
  # resolves to whatever that branch points at today, so two people — or the
  # same person a week apart — can get different builds from identical source.
  # Normally `flake.lock` handles this; pinning here achieves the same
  # determinism and keeps the tree honest for contributors who do not have
  # Nix installed and so cannot regenerate a lock.
  #
  # To update: bump these revisions deliberately, in their own commit, and
  # let the `nix` CI job prove the result still builds.
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/0ae2bc1419c3f345984c2629e72e7a631820fa4d";
    flake-utils.url = "github:numtide/flake-utils/11707dc2f618dd54ca8739b309ec4fc024de578b";
    rust-overlay = {
      url = "github:oxalica/rust-overlay/99607a06c2ea1290cd3258c11d1416dde9201f94";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      rust-overlay,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ (import rust-overlay) ];
        };

        # Read the same toolchain file the project pins for every other CI
        # path — rust-toolchain.toml says `channel = "1.95"`.
        rust = pkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml;

        rustPlatform = pkgs.makeRustPlatform {
          rustc = rust;
          cargo = rust;
        };
      in
      {
        packages.default = rustPlatform.buildRustPackage {
          pname = "ai-memory";
          version = (builtins.fromTOML (builtins.readFile ./Cargo.toml)).workspace.package.version;

          src = ./.;
          cargoLock.lockFile = ./Cargo.lock;

          # No nativeBuildInputs needed — the build is fully self-contained
          # (SQLite bundled, libgit2 vendored, rustls with webpki-roots).

          # Skip the Tailwind CLI download in the sandbox. The build script
          # falls back to the vendored static/tailwind.css committed to the
          # repo (see crates/ai-memory-web/build.rs).
          TAILWIND_SKIP = "1";

          buildType = "release";

          # The packaging test suite (tests/packaging.rs) exercises the
          # Docker-wrapper shell script `bin/ai-memory` and needs
          # docker/podman on PATH — not available in a Nix sandbox. The
          # rest of the workspace test suite (unit tests + integration)
          # does not need them and can be run via `nix develop -c cargo
          # test --workspace` on a machine with Docker.
          doCheck = false;

          # Install the bundled hook scripts alongside the binary,
          # mirroring what the AUR PKGBUILD does. Native binary users
          # (`ai-memory serve`, `install-hooks`) look up hooks under
          # the binary's share directory at runtime.
          #
          # `bin/ai-memory` (the Docker-wrapper shell script) is NOT
          # installed — Nix users build the native binary directly and
          # have no need for a Docker wrapper.
          postInstall = ''
            mkdir -p $out/share/ai-memory
            cp -a hooks $out/share/ai-memory/

            # Install the default config template so `ai-memory init`
            # has a known-good starting point without a network fetch.
            mkdir -p $out/etc/ai-memory
            cp crates/ai-memory-cli/templates/config.default.toml \
               $out/etc/ai-memory/config.default.toml
          '';

          meta = {
            description = "Long-term memory for AI coding agents";
            homepage = "https://github.com/akitaonrails/ai-memory";
            license = pkgs.lib.licenses.mit;
            mainProgram = "ai-memory";
          };
        };

        devShells.default = pkgs.mkShell {
          name = "ai-memory-dev";

          buildInputs = [
            rust
            pkgs.cargo-watch
          ];

          # Same escape hatch for local `cargo build` / `cargo test` —
          # prevents the web crate from trying to download Tailwind.
          TAILWIND_SKIP = "1";

          shellHook = ''
            echo ""
            echo "ai-memory dev shell — Rust $(rustc --version)"
            echo ""
            echo "  cargo build --workspace          # build"
            echo "  cargo test --workspace           # unit + integration tests"
            echo "  cargo test -p ai-memory-cli --test packaging  # needs docker"
            echo ""
          '';
        };
      }
    );
}
