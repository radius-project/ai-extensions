---
"radius": patch
---

Choose container image build platforms per image, from what the Dockerfile can actually build.

`Radius.Compute/containerImages` builds `linux/amd64` and `linux/arm64` when `build.platforms` is omitted, and there is no emulation fallback to rely on. A Dockerfile that cannot cross-compile either fails when an unpinned stage tries to execute target-platform binaries or yields an image whose manifest claims an architecture its copied binaries do not have. The guidance covering this was a single sentence asking the agent to validate the cross-build strategy, which left the judgment unanchored and the outcome different from one modeling run to the next.

Modeling now applies an explicit three-part test to each image. The final stage and everything it inherits from must not be fixed to one architecture, every architecture-specific artifact that reaches the final image must be built for the requested one, and every `RUN` stage must be executable by the amd64 builder without emulation. The distinction the old wording lost is that these compose: a `--platform=$BUILDPLATFORM` build stage compiling with `GOARCH=$TARGETARCH` is the correct cross-compile pattern, not a defect, while the same stage compiling native code that is then copied into an unpinned runtime stage is exactly the defect. An unpinned stage would produce requested-platform output, but any `RUN` in it makes the arm64 build unexecutable without emulation.

The decision is made per resource, so a repository whose Go services cross-compile and whose Python and Node services do not keeps multi-arch where it is real and pins only what has to be pinned, instead of pinning everything to the least capable Dockerfile. An image that has to be pinned is reported to the user along with the consequence, and an image fixed to an architecture the builder cannot produce is reported as a packaging gap rather than being given a platform it cannot honor.
