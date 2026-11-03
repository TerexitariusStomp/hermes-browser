#!/usr/bin/env bash
# Launch Chrome/Chromium with a working WebGPU adapter on this machine
# (NVIDIA 5070 Ti + Intel ARL iGPU, Wayland session).
#
# Why each flag (all load-bearing — verified 2026-11-02):
#   --ozone-platform=x11   Chromium's Vulkan backend does NOT work on the
#                          Wayland ozone platform ("not compatible with
#                          Vulkan"); XWayland is required. Without this,
#                          the GPU process dies and requestAdapter()->null.
#   --enable-features=Vulkan   Enables Vulkan compositing AND the Dawn
#                          Vulkan backend — without it only the SwiftShader
#                          software adapter appears.
#   --enable-unsafe-webgpu   Unblocks the WebGPU blocklist on Linux.
#   VK_ICD_FILENAMES         Forces which Vulkan device Dawn sees.
#                          intel_icd  -> stable, verified wllama offload
#                          nvidia_icd -> adapter exposes (blackwell) but
#                                        GPU process is crash-prone.
#   CDP probe MUST run on a real origin (http://localhost) — navigator.gpu
#   reports false on about:blank in some builds.
#
# Probe: node scripts/x11-site.mjs   (expects server on :8471)

GPU="${1:-intel}"   # intel | nvidia
ICD=/usr/share/vulkan/icd.d/${GPU}_icd.x86_64.json
CHROME="${CHROME:-/home/terex/Documents/hermes-browser/chrome/linux-156.0.8078.80/chrome-linux64/chrome}"

# NOTE: profiles live under $HOME — /tmp is a small tmpfs (16G) and large
# CacheStorage/IndexedDB writes (model weights) die with quota errors there.
VK_ICD_FILENAMES="$ICD" exec "$CHROME" \
  --remote-debugging-port=${PORT:-9223} \
  --user-data-dir=/home/terex/chrome-profiles/webgpu-$GPU \
  --no-first-run --no-sandbox \
  --ozone-platform=x11 \
  --enable-unsafe-webgpu \
  --use-angle=vulkan \
  --enable-features=Vulkan,VulkanFromANGLE \
  --enable-webgpu-developer-features \
  "${2:-about:blank}"
