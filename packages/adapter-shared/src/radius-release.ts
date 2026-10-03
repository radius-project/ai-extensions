// The Radius release this plugin build is validated against. Modeling (the
// managed `rad`), the deploy recipe catalog (`load-contrib-catalog`), and the
// deploy control plane (`setup-control-plane`) must all use this one release so
// the recipe read while modeling is the recipe that runs at deploy time.
//
// Keep in sync with RADIUS_INSTALL_REF in
// .github/extension/actions/setup-control-plane/action.yml.
// build/scripts/update-radius-installer.sh updates both, and
// build/scripts/verify-contrib-consumers.sh fails when they disagree.
export const RADIUS_RELEASE_TAG = "v0.61.1";
