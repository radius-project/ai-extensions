#!/usr/bin/env bash

set -euo pipefail

# Installs the yq YAML processor into a user-owned directory (no sudo) for the
# current platform. Works on linux and darwin, amd64 and arm64, for both CI and
# local development; under GitHub Actions the install dir is added to the job
# PATH so later steps can run yq.
#
# The pinned version and per-platform SHA-256 checksums are normally provided by
# build/tools.yaml through the generated Make include. The script is generic, so when a value
# is not supplied it is resolved at runtime:
#   * empty YQ_VERSION              -> the latest published release
#   * missing checksum for platform -> read from the release's own checksums file
#
# Usage: install-yq.sh [install_dir]
#
# Environment (all optional):
#   YQ_VERSION                Release tag, e.g. v4.53.3. Empty selects latest.
#   YQ_CHECKSUM_<OS>_<ARCH>   SHA-256 for that platform (e.g.
#                             YQ_CHECKSUM_LINUX_AMD64). Empty fetches it from the
#                             release's published checksums file.
#   YQ_INSTALL_DIR            Install directory. When empty the first writable
#                             candidate is used, starting with $HOME/.local/bin.
#   GITHUB_TOKEN              If set, authenticates GitHub requests (higher rate
#                             limits; required for private repositories).

readonly REPO="mikefarah/yq"
readonly RELEASES_URL="https://github.com/${REPO}/releases"

log() { echo "[install-yq] $*" >&2; }
fail() {
    echo "[install-yq] ERROR: $*" >&2
    exit 1
}

# Temporary working directory for downloads, removed on exit. Uses an explicit
# 'if' (not '&&') so the function returns 0 when WORKDIR is unset; otherwise the
# failing test would become the EXIT trap's status and abort an otherwise
# successful run, e.g. the early return when the tool is already installed.
WORKDIR=""
cleanup() {
    if [ -n "${WORKDIR:-}" ] && [ -d "${WORKDIR}" ]; then
        rm -rf "${WORKDIR}"
    fi
}

# curl wrapper for GitHub requests: enforces HTTPS + TLS 1.2, sets a User-Agent,
# and adds an Authorization header when GITHUB_TOKEN is set (raises API rate
# limits and allows private repositories). curl drops the Authorization header on
# cross-host redirects, so the token is not sent to the download CDN. The array is
# seeded with the User-Agent so it is never empty -- expanding an empty array
# under 'set -u' is an error on bash 3.2 (macOS).
gh_curl() {
    local headers=(-H "User-Agent: ${REPO##*/}-installer")
    if [ -n "${GITHUB_TOKEN:-}" ]; then
        headers+=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
    fi
    # --retry rides out transient failures (timeouts and HTTP 408/429/5xx such as
    # the 504 gateway timeouts GitHub's release CDN returns intermittently) with
    # exponential backoff, while still failing fast on 404s (a wrong version).
    curl --proto '=https' --tlsv1.2 --retry 5 --retry-connrefused "${headers[@]}" "$@"
}

detect_os() {
    case "$(uname -s)" in
        Linux) echo "linux" ;;
        Darwin) echo "darwin" ;;
        *) fail "unsupported OS '$(uname -s)' (supported: Linux, Darwin)" ;;
    esac
}

detect_arch() {
    case "$(uname -m)" in
        x86_64 | amd64) echo "amd64" ;;
        aarch64 | arm64) echo "arm64" ;;
        *) fail "unsupported architecture '$(uname -m)' (supported: amd64, arm64)" ;;
    esac
}

# Resolve the latest release tag by following the /releases/latest redirect.
# Avoids the GitHub API (no token, no rate limit).
resolve_latest_version() {
    local effective_url
    effective_url="$(gh_curl -fsSLI -o /dev/null -w '%{url_effective}' "${RELEASES_URL}/latest")" \
        || fail "could not resolve the latest yq version"
    printf '%s\n' "${effective_url##*/tag/}"
}

# Print the SHA-256 of an asset, read from the release's own checksums. yq
# publishes 'checksums' (one row per asset, many hash columns) alongside
# 'checksums_hashes_order' (the algorithm name for each column).
checksum_from_release() {
    local version="$1" asset="$2" order_index
    gh_curl -fsSL "${RELEASES_URL}/download/${version}/checksums_hashes_order" -o "${WORKDIR}/order" \
        || fail "could not download checksums_hashes_order for ${version}"
    gh_curl -fsSL "${RELEASES_URL}/download/${version}/checksums" -o "${WORKDIR}/checksums" \
        || fail "could not download checksums for ${version}"
    order_index="$(grep -n '^SHA-256$' "${WORKDIR}/order" | head -n1 | cut -d: -f1)" \
        || fail "SHA-256 column not found in checksums_hashes_order"
    # Column 1 is the filename; hash N is in column N+1.
    awk -v asset="$asset" -v col="$((order_index + 1))" \
        '$1 == asset { print $col }' "${WORKDIR}/checksums"
}

verify_checksum() {
    local expected="$1" file="$2"
    if command -v sha256sum >/dev/null 2>&1; then
        echo "${expected}  ${file}" | sha256sum -c - >/dev/null
    elif command -v shasum >/dev/null 2>&1; then
        echo "${expected}  ${file}" | shasum -a 256 -c - >/dev/null
    else
        fail "neither sha256sum nor shasum is available for checksum verification"
    fi
}

# Succeeds when the directory exists (or can be created) and the current user can
# write to it. A directory can exist and still be unwritable -- on GitHub-hosted
# runners container steps routinely leave root-owned directories under $HOME --
# so existence alone is not enough and the write is probed directly.
dir_is_usable() {
    local dir="$1" probe
    mkdir -p "$dir" 2>/dev/null || return 1
    probe="${dir}/.install-yq-write-test.$$"
    touch "$probe" 2>/dev/null || return 1
    rm -f "$probe"
}

# Choose where to install. An explicitly requested directory is honoured or the
# script fails, since silently installing elsewhere would surprise the caller.
# Otherwise the first writable candidate wins, so an unwritable $HOME/.local/bin
# degrades to the runner temp directory instead of aborting the job.
resolve_install_dir() {
    local requested="$1" candidate

    if [ -n "$requested" ]; then
        dir_is_usable "$requested" || fail "install directory '${requested}' is not writable"
        printf '%s\n' "$requested"
        return 0
    fi

    for candidate in "${HOME}/.local/bin" "${RUNNER_TEMP:-}/yq-bin" "${TMPDIR:-/tmp}/yq-bin"; do
        case "$candidate" in /yq-bin) continue ;; esac
        if dir_is_usable "$candidate"; then
            if [ "$candidate" != "${HOME}/.local/bin" ]; then
                log "'${HOME}/.local/bin' is not writable; installing to ${candidate} instead"
            fi
            printf '%s\n' "$candidate"
            return 0
        fi
    done

    fail "found no writable install directory (tried \$HOME/.local/bin, \$RUNNER_TEMP and \$TMPDIR)"
}

main() {
    local requested_dir install_dir os arch platform asset version checksum

    command -v curl >/dev/null 2>&1 || fail "curl is required but was not found"

    requested_dir="${1:-${YQ_INSTALL_DIR:-}}"

    os="$(detect_os)"
    arch="$(detect_arch)"
    platform="${os}_${arch}"
    asset="yq_${platform}"

    # Normalize the requested version: strip whitespace, treat empty as the
    # latest release, and accept a bare number (4.53.3) as well as a tag (v4.53.3).
    version="${YQ_VERSION:-}"
    version="${version//[[:space:]]/}"
    if [ -z "$version" ]; then
        log "resolving latest yq version..."
        version="$(resolve_latest_version)"
    elif [ "${version#[0-9]}" != "$version" ]; then
        version="v${version}"
    fi
    [ -n "$version" ] || fail "could not determine the yq version to install"

    if command -v yq >/dev/null 2>&1 && yq --version 2>/dev/null | grep -q "${version#v}"; then
        log "yq ${version} already installed: $(command -v yq)"
        return 0
    fi

    # Resolved before downloading so an unusable destination fails fast, and after
    # the early return above so an already-installed yq needs no writable directory.
    install_dir="$(resolve_install_dir "$requested_dir")"

    WORKDIR="$(mktemp -d)"

    # Expected checksum: prefer the value supplied for this platform, otherwise
    # read it from the release's own published checksums.
    case "$platform" in
        linux_amd64) checksum="${YQ_CHECKSUM_LINUX_AMD64:-}" ;;
        linux_arm64) checksum="${YQ_CHECKSUM_LINUX_ARM64:-}" ;;
        darwin_amd64) checksum="${YQ_CHECKSUM_DARWIN_AMD64:-}" ;;
        darwin_arm64) checksum="${YQ_CHECKSUM_DARWIN_ARM64:-}" ;;
        *) checksum="" ;;
    esac
    if [ -z "$checksum" ]; then
        log "no checksum supplied for ${platform}; reading it from the ${version} release..."
        checksum="$(checksum_from_release "$version" "$asset")"
    fi
    [ -n "$checksum" ] || fail "could not determine the SHA-256 checksum for ${asset} ${version}"

    log "downloading ${asset} ${version}..."
    gh_curl -fsSL "${RELEASES_URL}/download/${version}/${asset}" -o "${WORKDIR}/yq" \
        || fail "could not download ${asset} ${version}"
    verify_checksum "$checksum" "${WORKDIR}/yq"
    chmod 0755 "${WORKDIR}/yq"

    mv "${WORKDIR}/yq" "${install_dir}/yq"
    "${install_dir}/yq" --version >/dev/null 2>&1 \
        || fail "installed yq failed to run (${install_dir}/yq)"
    log "installed yq ${version} to ${install_dir}/yq"

    # Make yq available to later GitHub Actions steps.
    if [ -n "${GITHUB_PATH:-}" ]; then
        echo "$install_dir" >> "$GITHUB_PATH"
    fi
}

trap cleanup EXIT
main "$@"
