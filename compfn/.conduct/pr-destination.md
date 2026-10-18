# PR destination correction

This branch starts at sf-next/next b21477fc9 and applies the compfn implementation from 125f328c5. It replaces the misplaced origin draft #246; no changes from the broader origin/dev history are imported. Existing sf-next specifications and historical artifacts are preserved.

Prior package tests and packed/browser checks belong to the original implementation checkout. This new target has older shared packages and a different workspace graph: clean installation, lock reconciliation and target-context validation remain open before merge. Shared prerequisite publication or synchronization is required where package manifests request newer versions. This draft is not a completion claim.
