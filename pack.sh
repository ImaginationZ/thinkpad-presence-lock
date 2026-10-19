#!/bin/sh
# Build the extension zip, for install.sh or for upload to
# extensions.gnome.org. Prints the zip's path.
set -e
cd "$(dirname "$0")"

OUT_DIR=${1:-dist}
UUID=$(sed -n 's/.*"uuid": *"\([^"]*\)".*/\1/p' extension/metadata.json)

mkdir -p "$OUT_DIR"
gnome-extensions pack --force --extra-source=icons --out-dir="$OUT_DIR" extension
echo "$OUT_DIR/$UUID.shell-extension.zip"
