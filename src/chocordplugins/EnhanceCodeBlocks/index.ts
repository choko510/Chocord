/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import definePlugin from "@utils/types";
import legacyPluginSource from "file://./EnhanceCodeBlocks.plugin.js?trim=false";

import { createBdPluginBridge } from "../_api/bdCompat";

const bridge = createBdPluginBridge("EnhanceCodeBlocks", legacyPluginSource);

export default definePlugin({
    name: "EnhanceCodeBlocks",
    description: "Enhances Discord code blocks and text file attachment previews.",
    authors: [{
        name: "Doggybootsy",
        id: 0n
    }],
    settingsAboutComponent: bridge.settingsAboutComponent,
    start() {
        bridge.start();
    },
    stop() {
        bridge.stop();
    }
});
