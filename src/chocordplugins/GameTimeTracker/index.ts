/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import definePlugin from "@utils/types";
import legacyPluginSource from "file://./GameTimeTracker.plugin.js?trim=false";

import { createBdPluginBridge } from "../_api/bdCompat";

const bridge = createBdPluginBridge("GameTimeTracker", legacyPluginSource);

export default definePlugin({
    name: "GameTimeTracker",
    description: "Tracks time spent in games.",
    authors: [{
        name: "Yentis",
        id: 68834122860077056n
    }],
    settingsAboutComponent: bridge.settingsAboutComponent,
    start() {
        bridge.start();
    },
    stop() {
        bridge.stop();
    }
});
