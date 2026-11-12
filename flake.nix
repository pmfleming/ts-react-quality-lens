{
  description = "TypeScript and React quality measurement lens";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.buildNpmPackage {
            pname = "ts-react-quality-lens";
            version = "0.3.0";
            src = ./.;
            nodejs = pkgs.nodejs;
            npmDepsHash = "sha256-FDU7KUlB7TLYbgwAb0V8i+N+JQDu/UBwu7lmbyQ1tVU=";
            # jscpd v5 ships platform ELF binaries, not a JavaScript implementation.
            nativeBuildInputs = [ pkgs.autoPatchelfHook ];
            buildInputs = [ pkgs.stdenv.cc.cc.lib ];

            npmBuildScript = "build";
            # Keep analyzer tool dependencies available at runtime. The CLI loads
            # TypeScript directly and can run bundled jscpd/dependency-cruiser/ESLint
            # integrations when the measured project does not provide them.
            dontNpmPrune = true;

            meta = {
              description = "Reusable TypeScript and React quality measurement artifacts";
              homepage = "https://github.com/pmfleming/ts-react-quality-lens";
              license = pkgs.lib.licenses.mit;
              mainProgram = "ts-react-quality-lens";
            };
          };
        });

      devShells = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              git
              jq
              nodejs
              ripgrep
            ];

            shellHook = ''
              echo "ts-react-quality-lens dev shell"
              echo "  npm ci        # install JS dependencies"
              echo "  npm run ci    # typecheck, test, smoke checks"
            '';
          };
        });

      checks = forAllSystems (system: {
        package = self.packages.${system}.default;
      });
    };
}
