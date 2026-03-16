/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { EquicordDevs } from "@utils/constants";
import definePlugin from "@utils/types";
import legacyPluginSource from "file://./BetterMentions.plugin.js?trim=false";

import { createBdPluginBridge } from "../_api/bdCompat";

const bridge = createBdPluginBridge("BetterMentions", legacyPluginSource);

export default definePlugin({
    name: "BetterMentions",
    description: "Adds profile pictures to mentions and enables click-to-profile on text editor mentions.",
    authors: [EquicordDevs.DaddyBoard],
    settingsAboutComponent: bridge.settingsAboutComponent,
    start() {
        bridge.start();
    },
    stop() {
        bridge.stop();
    }
});
