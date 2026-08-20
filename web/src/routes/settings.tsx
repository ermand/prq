/**
 * Settings: which projects prq tracks.
 *
 * This is the first page in the app that writes anything. It writes local rows
 * only — the same database a sync and a census already write — and it cannot
 * reach a forge. prq stays read-only where that claim matters.
 */

import { createFileRoute } from "@tanstack/react-router";
import { SettingsPanel } from "../components/settings-panel";
import { getSettings } from "../server/settings";

export const Route = createFileRoute("/settings")({
  loader: () => getSettings(),
  component: Settings,
});

function Settings() {
  return <SettingsPanel settings={Route.useLoaderData()} />;
}
