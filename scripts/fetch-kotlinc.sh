#!/bin/sh
# Downloads the Kotlin compiler from GitHub releases into .tools/kotlinc so the
# test suite can compile generated Kotlin against API stubs. Optional: tests
# skip the Kotlin compile when kotlinc is missing.
set -e
VERSION="${KOTLIN_VERSION:-2.4.21}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/.tools"
mkdir -p "$DIR"
cd "$DIR"
curl -sSL -o kotlin-compiler.zip "https://github.com/JetBrains/kotlin/releases/download/v${VERSION}/kotlin-compiler-${VERSION}.zip"
rm -rf kotlinc
unzip -q kotlin-compiler.zip
rm kotlin-compiler.zip
"$DIR/kotlinc/bin/kotlinc" -version
