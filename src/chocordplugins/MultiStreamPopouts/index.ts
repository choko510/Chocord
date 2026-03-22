/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { EquicordDevs } from "@utils/constants";
import definePlugin from "@utils/types";
import legacyPluginSource from "file://./MultiStreamPopouts.plugin.js?trim=false";

import { createBdPluginBridge } from "../_api/bdCompat";

const bridge = createBdPluginBridge("MultiStreamPopouts", legacyPluginSource);

export default definePlugin({
    name: "MultiStreamPopouts",
    description: "Allows you to open multiple streams each in their own popout windows.",
    authors: [EquicordDevs.HypedDomi],
    settingsAboutComponent: bridge.settingsAboutComponent,
    start() {
        bridge.start();
    },
    stop() {
        bridge.stop();
    }
});
