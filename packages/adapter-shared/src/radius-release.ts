import radiusRelease from "./radius-release.json" with { type: "json" };

// The Radius release this plugin build is validated against. Modeling (the
// managed `rad`), the deploy recipe catalog (`load-contrib-catalog`), and the
// deploy control plane (`setup-control-plane`) must all use this one release so
// the recipe read while modeling is the recipe that runs at deploy time.
//
// radius-release.json is the authoritative pin. The setup-control-plane action
// keeps literal copies (RADIUS_INSTALL_REF and RADIUS_INSTALL_COMMIT) because
// consumer repositories only receive .github/extension/.
// build/scripts/update-radius-installer.sh updates both, and
// build/scripts/verify-contrib-consumers.sh fails when they disagree.
export const RADIUS_RELEASE_TAG: string = radiusRelease.tag;
export const RADIUS_RELEASE_COMMIT: string = radiusRelease.commit;
