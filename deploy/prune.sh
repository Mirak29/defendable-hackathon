#!/bin/sh
# Run in the same layer as `deno install` (see the Dockerfile): removes what the
# server never loads on this Linux machine (x86-64, or ARM64 such as a Mac with
# Apple silicon), so the image is lighter. A file
# is in two places (node_modules and the cache of Deno, hardlinked): both are
# cleaned, otherwise nothing is freed. Only files inside the packages go: the
# package folders stay, so Deno finds the same tree as after the install.
set -eu

roots="/app/node_modules/.deno /deno-dir/npm"

# onnxruntime-node ships the binaries of every system; the voice runs on this
# one: the binaries of the machine that builds the image stay, the others go
case "$(uname -m)" in
  aarch64 | arm64) other=x64 ;;
  *) other=arm64 ;;
esac
find $roots -type d -path '*onnxruntime-node*/bin/napi-v3/*' \
  \( -name darwin -o -name win32 -o -path "*/linux/$other" \) -prune \
  -exec rm -rf {} +

# onnxruntime-web is the browser runtime: transformers.node.mjs does not load it
find $roots -type f -path '*onnxruntime-web*' -size +100k -delete

# sharp: the libvips build for musl (Alpine), this image is Debian
find $roots -type f -path '*sharp-libvips-linuxmusl-x64*' -size +100k -delete

# transformers.js: the browser builds and the source maps, the server loads
# dist/transformers.node.mjs
find $roots -type f -path '*@huggingface/transformers*/dist/*' \
  \( -name 'transformers.web*' -o -name 'transformers.js*' \
  -o -name 'transformers.min.js*' -o -name 'ort-wasm*' -o -name '*.map' \) \
  -delete
